"""GenLayer contract layer for the reputation oracle.

This file is the *shell*: everything that talks to the chain, and nothing that
decides a number. `build_contract.py` splices the deterministic engine
(`reputation_core.py`) and the prompt builder (`reputation_prompts.py`) into the
marker below and writes `reputation_oracle.py`, which is the single file that
actually deploys. Editing the generated file directly is a mistake - it is
overwritten, and `test_build_contract.py` fails when it drifts.

The split is deliberate. The engine is 279 tests of pure integer arithmetic that
runs with no GenLayer runtime present; the shell cannot be unit-tested at all
without the GenVM, because `from genlayer import *` only resolves inside it.
Keeping the untestable part small and free of arithmetic is what stops the
untestable part from being where a scoring bug hides.

Three contract-layer decisions worth stating, because none of them are obvious
from the engine:

**Storage is flat.** `Policy` and `Report` are frozen dataclasses, which are not
storage types, so the ten policy fields are stored as individual `u256` and a
`Policy` is rebuilt in memory per call. Attestations are parallel `DynArray`s
indexed by a shared integer id rather than a `DynArray` of structs, because that
needs `gl.storage.inmem_allocate` and the parallel form uses only constructs
whose semantics are unambiguous. It is less pretty and it is the version I can
reason about without a runtime to check me against.

**Grading uses `run_nondet`, not `eq_principle.prompt_comparative`.** The
engine already ships the exact comparison this needs: `grades_agree` allows a
numeric tolerance per graded field, and `errors_agree` classifies failures so
validators agree about *failing* too. Asking an LLM to judge whether two JSON
grades are "equivalent" would throw that precision away and put a second
non-deterministic judgement inside the consensus step.

**Money moves on explicit calls only.** A slashed bond stays with the contract; a
releasable one is reclaimed by the attester after the lock elapses. Work
collateral settles the same way: `attest` marks it releasable or forfeit and
moves nothing, and `release_collateral` / `claim_collateral` are what transfer.
Nothing moves implicitly during grading, so a failed nondet round cannot strand
or duplicate a payment.

**Two payable paths, two different mechanisms.** `attest` is payable because
writing a review costs a bond, which doubles per repeat and prices sybil
attestation. `accept_engagement` is payable because *taking on work* costs
collateral, which is priced from the provider's own `score_bp` and falls as that
score rises. Only the second one converts reputation into money at risk, and it
is the one the whole engine exists to feed - the bond curve would be worth
building even if no score were ever computed from it.

One warning about the SDK, because it cost a full rewrite to learn. Two
generations of `py-genlayer` are in circulation and they disagree about most of
the names below. This file is written against the generation the pinned runner
loads (std lib `11rhn002...`): `from genlayer import *` exposing a `gl` proxy,
`gl.Contract`, `gl.vm.run_nondet`, `gl.vm.UserError` (a dataclass with
`.message`), `gl.message_raw["datetime"]`, and `gl.get_contract_at(addr)
.emit_transfer(value=...)`. The other generation spells those
`import genlayer as gl`, `gl.contract.Contract`, `run_nondet_default`,
`UserError.immediate` / `.data`, `gl.message.raw`, and `gl.chain.Account`. The
published API reference at sdk.genlayer.com documents the second set plus a
`gl.vm.get_timestamp` that exists in neither. Check names against the extracted
std library and `genvm-lint check`, never against the website.
"""

from __future__ import annotations

from genlayer import *

#<<<ENGINE>>>

# --- contract ---------------------------------------------------------------

# Engagement lifecycle. Stored as an integer rather than a string because absent
# and open must be distinguishable, and a TreeMap read of a missing key yields
# the zero value.
_ENG_ABSENT = 0
_ENG_PROPOSED = 1  # named by the client; the provider has not agreed yet
_ENG_OPEN = 2
_ENG_CLOSED = 3

# Wire names for the same states, for `get_engagement`. Clients branch on these,
# so they are a stable surface rather than the integers, which are storage.
_ENG_STATE_NAMES = {
    _ENG_PROPOSED: "proposed",
    _ENG_OPEN: "open",
    _ENG_CLOSED: "closed",
}

# Bond lifecycle for one attestation.
_BOND_NONE = "none"  # nothing was posted (policy min_bond == 0)
_BOND_LOCKED = "locked"  # releasable, still inside the lock window
_BOND_RELEASED = "released"  # returned to the attester
_BOND_SLASHED = "slashed"  # kept by the contract, unsubstantiated claim

# Collateral lifecycle for one engagement. The provider posts it to accept the
# work, priced off their own score, and it settles when the client grades them.
_COL_NONE = "none"  # nothing was posted (the engagement declared no stake)
_COL_HELD = "held"  # posted, and the work has not been graded yet
_COL_RELEASABLE = "releasable"  # graded, and the work stands: the provider may take it back
_COL_FORFEIT = "forfeit"  # graded unfulfilled by an attestation that counts: the client may claim it
_COL_RETURNED = "returned"  # back with the provider
_COL_CLAIMED = "claimed"  # paid to the client

_MAX_ID_CHARS = 128

# Largest page any paged view will return. Bounds the response a single call can
# be asked to build, which is the only thing standing between an append-only
# array and a view that eventually cannot be answered.
_PAGE_MAX = 50


def _slice(items, offset: int, limit: int) -> list:
    """One clamped page of a stored array.

    Clamping rather than rejecting: a caller who asks for more than `_PAGE_MAX`
    gets `_PAGE_MAX`, and one who pages past the end gets an empty list. Both are
    ordinary conditions for a client walking a list whose length it learned from
    a previous call, and neither deserves a failed transaction.
    """
    if limit <= 0 or offset < 0:
        return []
    if limit > _PAGE_MAX:
        limit = _PAGE_MAX
    total = len(items)
    if offset >= total:
        return []
    stop = offset + limit
    if stop > total:
        stop = total
    return [items[index] for index in range(offset, stop)]


def _owed_key(address: Address) -> str:
    """The storage key for an entitlement: the address, lowercased.

    `Address.as_hex` returns the EIP-55 checksummed form, so it is only stable
    as a key if every reader spells it identically. Lowercasing once, here,
    means a caller holding either form finds the same entry.
    """
    return address.as_hex.lower()


def _fail(reason: str) -> None:
    """Raise a classified, deterministic error.

    Every rejection in this contract is `[EXPECTED]`: it is derived purely from
    stored state and calldata, so every honest validator derives the identical
    string and `errors_agree` can compare them exactly. Unclassified failures
    force validator rotation instead, which is the correct outcome for a bug but
    the wrong one for a business rule.

    `gl.vm.UserError` is a dataclass carrying a single `message`, and raising it
    is the idiom this runner's standard library provides. (The newer SDK
    generation offers `UserError.immediate(...)` and names the field `data`;
    neither exists here.)
    """
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {reason}")


def _now_seconds() -> int:
    """Consensus time as whole epoch seconds, UTC.

    Routed through `parse_block_time` rather than converted here so the one
    timezone-sensitive conversion in the system stays in the tested module. In
    deterministic mode this is the transaction timestamp, identical on every
    node.

    `gl.message_raw["datetime"]` is a *string*, which is exactly the input
    `parse_block_time` documents itself as taking. There is no timestamp on
    `gl.message` — it is a five-field NamedTuple here (`contract_address`,
    `sender_address`, `origin_address`, `value`, `chain_id`) — and no
    `gl.vm.get_timestamp` in this runner's standard library, despite the
    published API reference describing one.
    """
    return parse_block_time(gl.message_raw["datetime"])


def _pair_key(attester: Address, subject: Address) -> str:
    """Index key for one attester's history about one subject.

    Both halves are normalized and the separator is a character that cannot
    appear in either, so no two distinct pairs can collide into one bucket.
    """
    return f"{normalize_address(attester.as_hex)}|{normalize_address(subject.as_hex)}"


# Named for what it is, and deliberately not `Contract`. The runner finds the
# contract by subclass registration (`__init_subclass__` sets `__known_contract__`),
# so any name deploys - but every offline tool finds it by *searching* the module,
# and `genvm-lint`'s search skips the name `Contract` outright, because
# `from genlayer import *` binds the base class under exactly that name and a
# module-level scan cannot tell the two apart. A contract called `Contract`
# therefore lints clean and then fails validation with "No contract class found",
# taking the ABI schema down with it.
class ReputationOracle(gl.Contract):
    owner: Address

    # Policy, one field per storage slot. See the module docstring.
    p_half_life_seconds: u256
    p_prior_weight: u256
    p_min_substantiated: u256
    p_min_confidence: u256
    p_confidence_tol: u256
    p_repeat_shift_cap: u256
    p_min_bond: u256
    p_slash_floor: u256
    p_release_floor: u256
    p_bond_lock_seconds: u256
    p_collateral_ceiling_bp: u256
    p_collateral_floor_bp: u256
    p_collateral_forfeit_bp: u256

    # Engagements, keyed by a caller-supplied id.
    eng_client: TreeMap[str, Address]
    eng_provider: TreeMap[str, Address]
    eng_scope: TreeMap[str, str]
    eng_digest: TreeMap[str, str]
    eng_state: TreeMap[str, u256]
    # The declared value of the work, and what accepting it cost the provider.
    # `eng_score_bp` is the provider's score at the moment they accepted, kept
    # because the collateral is derived from it and a derivation nobody can see
    # afterwards is indistinguishable from an arbitrary number.
    eng_stake: TreeMap[str, u256]
    eng_closed_at: TreeMap[str, u256]
    eng_collateral: TreeMap[str, u256]
    eng_collateral_rate_bp: TreeMap[str, u256]
    eng_score_bp: TreeMap[str, u256]
    eng_collateral_state: TreeMap[str, str]

    # Attestations. Append-only; the shared index is the attestation id.
    att_engagement: DynArray[str]
    att_attester: DynArray[Address]
    att_subject: DynArray[Address]
    att_claim: DynArray[str]
    att_evidence: DynArray[str]
    att_created_at: DynArray[u256]
    att_verdict: DynArray[str]
    att_fulfilled: DynArray[u256]
    att_substantiated: DynArray[u256]
    att_confidence: DynArray[u256]
    att_repeat_index: DynArray[u256]
    att_bond: DynArray[u256]
    att_bond_state: DynArray[str]

    # Entitlements. Settlement credits here; `withdraw` is the only method that
    # moves value out. Keyed by the recipient's lowercase hex, because a
    # `TreeMap[Address, u256]` cannot be read back by an off-chain caller that
    # only has the string form.
    owed: TreeMap[str, u256]
    # Value that `withdraw` has emitted but whose arrival this contract cannot
    # observe. Held separately from `owed` so a payout that never lands is
    # recoverable instead of simply gone. See `withdraw` and `reclaim_in_flight`.
    in_flight: TreeMap[str, u256]
    # Running totals of both maps, so solvency can be checked in constant time.
    # Without them `reclaim_in_flight` would have to walk every entitlement to
    # decide whether restoring one is backed by real balance.
    total_owed: u256
    total_in_flight: u256

    # Indexes.
    subject_atts: TreeMap[Address, DynArray[u256]]
    pair_count: TreeMap[str, u256]
    engagement_attested: TreeMap[str, bool]
    pair_count: TreeMap[str, u256]
    engagement_attested: TreeMap[str, bool]

    def __init__(
        self,
        half_life_seconds: u256 = 7776000,
        prior_weight: u256 = 30000,
        min_substantiated: u256 = 25,
        min_confidence: u256 = 50,
        confidence_tol: u256 = 20,
        repeat_shift_cap: u256 = 8,
        min_bond: u256 = 0,
        slash_floor: u256 = 20,
        release_floor: u256 = 50,
        bond_lock_seconds: u256 = 1209600,
        collateral_ceiling_bp: u256 = 15000,
        collateral_floor_bp: u256 = 2500,
        collateral_forfeit_bp: u256 = 2500,
    ):
        """Deploy with a policy.

        Defaults mirror `Policy`'s own, so a bare deployment behaves exactly like
        the engine's defaults. The policy is validated here rather than trusted:
        an inverted slash/release band would make `bond_outcome` arbitrary, and
        catching that at deployment is far cheaper than discovering it when the
        first bond is judged.
        """
        candidate = Policy(
            half_life_seconds=half_life_seconds,
            prior_weight=prior_weight,
            min_substantiated=min_substantiated,
            min_confidence=min_confidence,
            confidence_tol=confidence_tol,
            repeat_shift_cap=repeat_shift_cap,
            min_bond=min_bond,
            slash_floor=slash_floor,
            release_floor=release_floor,
            bond_lock_seconds=bond_lock_seconds,
            collateral_ceiling_bp=collateral_ceiling_bp,
            collateral_floor_bp=collateral_floor_bp,
            collateral_forfeit_bp=collateral_forfeit_bp,
        )
        try:
            candidate.validate()
        except ValueError as exc:
            _fail(f"invalid_policy:{exc}")

        self.owner = gl.message.sender_address
        self.p_half_life_seconds = half_life_seconds
        self.p_prior_weight = prior_weight
        self.p_min_substantiated = min_substantiated
        self.p_min_confidence = min_confidence
        self.p_confidence_tol = confidence_tol
        self.p_repeat_shift_cap = repeat_shift_cap
        self.p_min_bond = min_bond
        self.p_slash_floor = slash_floor
        self.p_release_floor = release_floor
        self.p_bond_lock_seconds = bond_lock_seconds
        self.p_collateral_ceiling_bp = collateral_ceiling_bp
        self.p_collateral_floor_bp = collateral_floor_bp
        self.p_collateral_forfeit_bp = collateral_forfeit_bp

        # Plain `0`, never `u256(0)`: on this runner the integer aliases are
        # `typing.Annotated[int, ...]`, so they annotate and do not call.
        self.total_owed = 0
        self.total_in_flight = 0

    def _policy(self) -> Policy:
        """Rebuild the in-memory policy from storage."""
        return Policy(
            half_life_seconds=int(self.p_half_life_seconds),
            prior_weight=int(self.p_prior_weight),
            min_substantiated=int(self.p_min_substantiated),
            min_confidence=int(self.p_min_confidence),
            confidence_tol=int(self.p_confidence_tol),
            repeat_shift_cap=int(self.p_repeat_shift_cap),
            min_bond=int(self.p_min_bond),
            slash_floor=int(self.p_slash_floor),
            release_floor=int(self.p_release_floor),
            bond_lock_seconds=int(self.p_bond_lock_seconds),
            collateral_ceiling_bp=int(self.p_collateral_ceiling_bp),
            collateral_floor_bp=int(self.p_collateral_floor_bp),
            collateral_forfeit_bp=int(self.p_collateral_forfeit_bp),
        )

    # --- engagements --------------------------------------------------------

    @gl.public.write
    def open_engagement(
        self, engagement_id: str, provider: Address, scope: str, stake: u256 = 0
    ) -> None:
        """Commit a scope, and the value of the work, before the work starts.

        The digest is taken here, at open time, which is the whole point: once
        the outcome is known neither party can retrofit the standard being graded
        against. The scope text is stored alongside it so the grading prompt can
        be rebuilt byte-identically by every validator later.

        `stake` is the declared value of the work in the chain's base units, and
        it is what the provider's collateral is priced against when they accept.
        It is committed here for the same reason the scope is: the price of
        taking on the job has to be fixed before anyone knows how the job went,
        and a stake the client could raise afterwards would be a bill the
        provider never agreed to. The contract does not custody the client's
        payment - only the provider's collateral - so an inflated stake is not a
        way to extract money from a provider, it is a way to be refused: the
        provider reads it before accepting, and simply does not accept.

        A stake of zero is a legitimate engagement with the collateral layer off,
        which is what the lifecycle was before it had one.
        """
        if not engagement_id or len(engagement_id) > _MAX_ID_CHARS:
            _fail("bad_engagement_id")
        if self.eng_state.get(engagement_id, _ENG_ABSENT) != _ENG_ABSENT:
            _fail("engagement_exists")
        if not scope.strip():
            _fail("empty_scope")

        # Calldata integers are unbounded, and the collateral derived from this
        # is `stake * collateral_ceiling_bp // BP` - which can exceed `u256` for
        # a stake that fits in one. Rejecting here is a classified refusal every
        # validator derives alike; letting it through would fault inside a `u256`
        # conversion at accept time, which is not.
        declared = int(stake)
        if declared < 0 or declared > max_stake(self._policy()):
            _fail(REASON_STAKE_OUT_OF_RANGE)

        client = gl.message.sender_address
        if provider == client:
            _fail("provider_is_client")

        self.eng_client[engagement_id] = client
        self.eng_provider[engagement_id] = provider
        self.eng_scope[engagement_id] = scope
        self.eng_digest[engagement_id] = scope_digest(scope)
        self.eng_stake[engagement_id] = declared
        self.eng_collateral_state[engagement_id] = _COL_NONE
        # Proposed, not open. The provider named above has not agreed to anything
        # yet, and until they do nothing about this engagement can reach a score.
        self.eng_state[engagement_id] = _ENG_PROPOSED

    @gl.public.write.payable
    def accept_engagement(self, engagement_id: str) -> u256:
        """Take on the work, posting collateral priced by your own reputation.

        This is where the score stops being a number to read and starts being a
        number that costs money. The provider's standing is computed from the
        same stored grades `get_report` walks, `collateral_required` converts it
        into a share of the engagement's committed stake, and an acceptance that
        arrives with less value than that is refused before the engagement opens.
        A well-reviewed agent unlocks the same work for a fraction of the capital
        an unknown one needs: at the deployed policy, 25% of the stake at a
        perfect record against 150% at none, and 87.5% for an agent with no
        history at all.

        The score is read here and frozen into storage rather than read again
        later. Collateral is a price agreed at the moment of taking the job;
        recomputing it afterwards would mean an agent's later reviews
        retroactively changed what an earlier job cost them.

        It is also still the consent step, and that ordering matters: only the
        named provider can call it, so the collateral is always posted by the
        party being graded, out of their own funds, against a scope they read
        first.

        Returns the collateral actually held, so a caller can show what they
        posted rather than what they sent.
        """
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)
        if state != _ENG_PROPOSED:
            _fail(REASON_ALREADY_ACCEPTED)
        provider = self.eng_provider[engagement_id]
        if gl.message.sender_address != provider:
            _fail(REASON_NOT_PROVIDER)

        policy = self._policy()
        stake = int(self.eng_stake.get(engagement_id, 0))
        score_bp = int(self._report(provider)["score_bp"])
        required = collateral_required(score_bp, stake, policy)

        # The gate closes before the state changes, so an underfunded acceptance
        # leaves the engagement a proposal rather than open work backed by
        # nothing.
        posted = int(gl.message.value)
        if posted < required:
            _fail(REASON_COLLATERAL_TOO_SMALL)

        self.eng_score_bp[engagement_id] = score_bp
        self.eng_collateral_rate_bp[engagement_id] = collateral_rate_bp(score_bp, policy)
        self.eng_collateral[engagement_id] = required
        self.eng_collateral_state[engagement_id] = _COL_HELD if required > 0 else _COL_NONE
        self.eng_state[engagement_id] = _ENG_OPEN

        # Overpayment goes straight back, as it does in `attest`. Holding it
        # would make the collateral curve a floor rather than a price, and the
        # curve is the entire argument for having a score at all.
        excess = posted - required
        if excess > 0:
            self._credit(provider, excess)

        return required

    @gl.public.write
    def close_engagement(self, engagement_id: str) -> None:
        """Mark the work finished, which is what opens attestation."""
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)
        if state == _ENG_CLOSED:
            _fail("engagement_already_closed")
        # A proposal nobody accepted is not work that can be finished. Closing it
        # would otherwise be the whole attack: name a victim, close, attest.
        if state == _ENG_PROPOSED:
            _fail(REASON_NOT_ACCEPTED)

        sender = gl.message.sender_address
        if sender != self.eng_client[engagement_id] and sender != self.eng_provider[engagement_id]:
            _fail(REASON_NOT_COUNTERPARTY)

        self.eng_state[engagement_id] = _ENG_CLOSED
        # Stamped because the collateral's dispute window runs from here. A
        # client who never attests cannot strand a provider's capital; they can
        # only delay its return by the length of the lock.
        self.eng_closed_at[engagement_id] = _now_seconds()

    # --- attestation --------------------------------------------------------

    @gl.public.write.payable
    def attest(self, engagement_id: str, claim: str, evidence: str) -> u256:
        """Grade one counterparty's account of a closed engagement.

        Exactly one LLM call per attestation, and none per read: aggregation is
        arithmetic over grades that were settled when they were written, so an
        agent with a long history costs no more to score than a new one.

        Returns the attestation id.
        """
        policy = self._policy()

        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)
        if state != _ENG_CLOSED:
            _fail(REASON_NOT_CLOSED)

        attester = gl.message.sender_address
        client = self.eng_client[engagement_id]
        provider = self.eng_provider[engagement_id]
        if attester == client:
            subject = provider
        elif attester == provider:
            subject = client
        else:
            _fail(REASON_NOT_COUNTERPARTY)

        seen_key = f"{engagement_id}|{normalize_address(attester.as_hex)}"
        if self.engagement_attested.get(seen_key, False):
            _fail(REASON_ALREADY_ATTESTED)

        pair = _pair_key(attester, subject)
        repeat_index = int(self.pair_count.get(pair, 0))

        # Bond first. The economic gate has to close before the model is paid to
        # read anything, or an attacker gets free grading by underfunding.
        required = bond_required(repeat_index, policy)
        posted = int(gl.message.value)
        if posted < required:
            _fail(REASON_BOND_TOO_SMALL)

        scope = self.eng_scope[engagement_id]
        salt = attestation_salt(
            scope=scope,
            attester=attester.as_hex,
            subject=subject.as_hex,
            claim=claim,
        )
        prompt = build_attestation_prompt(
            salt=salt,
            scope=scope,
            claim=claim,
            evidence=evidence,
        )

        def leader() -> dict:
            return canonicalize_grade(
                gl.nondet.exec_prompt(prompt, response_format="json"), policy
            )

        def validator(result: gl.vm.Result) -> bool:
            # Anything other than a clean return is a disagreement here. Error
            # comparison is handled by `compare_user_errors` below, which is a
            # different question from "is the leader's grade my grade".
            if not isinstance(result, gl.vm.Return):
                return False
            # `decode_grade`, not `canonicalize_grade`: the leader's value is
            # already canonical, and re-canonicalizing would widen `fulfilled` to
            # basis points a second time and saturate every real grade to 10000.
            theirs = decode_grade(result.calldata, policy)
            mine = canonicalize_grade(
                gl.nondet.exec_prompt(prompt, response_format="json"), policy
            )
            return grades_agree(mine, theirs, policy)

        def compare_errors(mine: gl.vm.UserError, theirs: gl.vm.UserError) -> bool:
            # `.message`, not `.data`: this runner's `UserError` is a dataclass
            # with a single `message` field.
            return errors_agree(mine.message, theirs.message)

        # `run_nondet`, not `run_nondet_unsafe`: the unsafe form does not sandbox
        # the validator, so a validator that raises is indistinguishable from one
        # that disagreed, and `compare_user_errors` does not exist on it at all.
        # Error agreement is half of what consensus means here.
        #
        # The decorator on `run_nondet` makes the plain call eager -- it returns
        # the leader's value, and `.lazy(...)` is the opt-in that returns `Lazy`.
        grade = gl.vm.run_nondet(
            leader,
            validator,
            compare_user_errors=compare_errors,
        )

        now = _now_seconds()
        outcome = bond_outcome(grade, policy)
        if required == 0:
            bond_state = _BOND_NONE
        elif outcome == BOND_SLASHED:
            bond_state = _BOND_SLASHED
        else:
            bond_state = _BOND_LOCKED

        attestation_id = len(self.att_engagement)
        self.att_engagement.append(engagement_id)
        self.att_attester.append(attester)
        self.att_subject.append(subject)
        self.att_claim.append(claim)
        self.att_evidence.append(evidence)
        self.att_created_at.append(now)
        self.att_verdict.append(grade["verdict"])
        self.att_fulfilled.append(grade["fulfilled"])
        self.att_substantiated.append(grade["substantiated"])
        self.att_confidence.append(grade["confidence"])
        self.att_repeat_index.append(repeat_index)
        self.att_bond.append(required)
        self.att_bond_state.append(bond_state)

        self.subject_atts.get_or_insert_default(subject).append(attestation_id)
        self.pair_count[pair] = repeat_index + 1
        self.engagement_attested[seen_key] = True

        # Settle the provider's work collateral, if this is the grade that
        # decides it. Only the client's attestation about the provider can be:
        # the provider grading the client back says nothing about whether the
        # work was delivered, and an engagement whose provider posted nothing has
        # nothing to settle. Nothing is transferred here - the state is marked
        # and the money moves on `release_collateral` or `claim_collateral`, so a
        # failed nondet round cannot strand or duplicate a payment.
        held = self.eng_collateral_state.get(engagement_id, _COL_NONE)
        if subject == provider and held == _COL_HELD:
            if collateral_outcome(grade, policy) == COLLATERAL_FORFEIT:
                self.eng_collateral_state[engagement_id] = _COL_FORFEIT
            else:
                self.eng_collateral_state[engagement_id] = _COL_RELEASABLE

        # Overpayment is returned immediately. Holding it would make the bond
        # curve a floor rather than a price, and the curve is the argument.
        excess = posted - required
        if excess > 0:
            self._credit(attester, excess)

        return attestation_id

    @gl.public.write
    def reclaim_bond(self, attestation_id: u256) -> None:
        """Return a releasable bond once its lock has elapsed."""
        index = int(attestation_id)
        if index < 0 or index >= len(self.att_engagement):
            _fail("no_such_attestation")

        attester = self.att_attester[index]
        if gl.message.sender_address != attester:
            _fail("not_the_attester")

        state = self.att_bond_state[index]
        if state == _BOND_SLASHED:
            _fail("bond_slashed")
        if state == _BOND_RELEASED:
            _fail("bond_already_released")
        if state == _BOND_NONE:
            _fail("no_bond_posted")

        policy = self._policy()
        unlock_at = int(self.att_created_at[index]) + policy.bond_lock_seconds
        if _now_seconds() < unlock_at:
            _fail("bond_still_locked")

        amount = int(self.att_bond[index])
        # `emit_transfer` raises a bare `ValueError` on a non-positive amount,
        # which would surface as an unclassified VM fault rather than a rejection
        # every validator derives alike. The `_BOND_NONE` check above should
        # already make this unreachable; classifying it costs one branch and
        # keeps the guarantee that every failure out of this contract is
        # comparable.
        if amount <= 0:
            _fail("no_bond_posted")

        self.att_bond_state[index] = _BOND_RELEASED
        self._credit(attester, amount)

    # --- collateral ---------------------------------------------------------

    @gl.public.write
    def release_collateral(self, engagement_id: str) -> None:
        """Return work collateral to the provider who posted it.

        Two ways to reach this. The ordinary one is that the client attested and
        the grade did not forfeit: the outcome is settled, and the capital is
        free the moment it is known. The other is that nobody ever attested -
        which a client can always choose - and for that case the collateral
        leaves once the engagement has been closed for the dispute window. A
        counterparty who declines to grade must not be able to hold an agent's
        working capital indefinitely; that would make silence a weapon and
        collateral a hostage.

        The window is `bond_lock_seconds`, deliberately the same one a bond waits
        out. It is one dispute window for one protocol rather than two numbers
        that would drift apart in a policy table.
        """
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)

        provider = self.eng_provider[engagement_id]
        if gl.message.sender_address != provider:
            _fail(REASON_NOT_PROVIDER)

        held = self.eng_collateral_state.get(engagement_id, _COL_NONE)
        if held == _COL_NONE:
            _fail(REASON_NO_COLLATERAL)
        if held == _COL_FORFEIT:
            _fail(REASON_COLLATERAL_FORFEITED)
        if held == _COL_RETURNED or held == _COL_CLAIMED:
            _fail(REASON_COLLATERAL_SETTLED)

        if held == _COL_HELD:
            if state != _ENG_CLOSED:
                _fail(REASON_NOT_CLOSED)
            policy = self._policy()
            unlock_at = int(self.eng_closed_at.get(engagement_id, 0)) + policy.bond_lock_seconds
            if _now_seconds() < unlock_at:
                _fail(REASON_COLLATERAL_HELD)

        amount = int(self.eng_collateral.get(engagement_id, 0))
        # `emit_transfer` raises a bare `ValueError` on a non-positive amount,
        # which surfaces as an unclassified VM fault rather than a rejection
        # every validator derives alike. The `_COL_NONE` branch above should make
        # this unreachable; classifying it costs one branch.
        if amount <= 0:
            _fail(REASON_NO_COLLATERAL)

        self.eng_collateral_state[engagement_id] = _COL_RETURNED
        self._credit(provider, amount)

    @gl.public.write
    def claim_collateral(self, engagement_id: str) -> None:
        """Pay forfeited collateral to the client the work was owed to.

        The other half of what makes collateral collateral. A forfeit that stayed
        with the contract would price undelivered work without compensating
        anyone for it, and the guarantee a client is buying is precisely that
        someone is made whole.

        Forfeiture is not the client's decision, which is the part worth being
        careful about: they can only claim what an attestation already forfeited,
        and that attestation had to be substantiated enough to carry weight in
        the score before it could forfeit anything. Accusation alone moves no
        money.
        """
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)

        client = self.eng_client[engagement_id]
        if gl.message.sender_address != client:
            _fail(REASON_NOT_CLIENT)

        held = self.eng_collateral_state.get(engagement_id, _COL_NONE)
        if held == _COL_RETURNED or held == _COL_CLAIMED:
            _fail(REASON_COLLATERAL_SETTLED)
        if held != _COL_FORFEIT:
            _fail(REASON_COLLATERAL_NOT_FORFEITED)

        amount = int(self.eng_collateral.get(engagement_id, 0))
        if amount <= 0:
            _fail(REASON_NO_COLLATERAL)

        self.eng_collateral_state[engagement_id] = _COL_CLAIMED
        self._credit(client, amount)

    # --- entitlements and withdrawal ----------------------------------------
    #
    # Every entitlement key goes through `_owed_key`, which lowercases. This is
    # not cosmetic: `Address.as_hex` returns the **EIP-55 checksummed** form,
    # with mixed case derived from a keccak hash of the digits. Crediting under
    # `as_hex` while reading under a lowercased string is two different keys for
    # one address, and the failure is quiet in the worst way -- `withdraw` works,
    # because it hashes the same way on both sides, while `owed_to` reports zero
    # to everyone forever.

    def _credit(self, recipient: Address, amount: int) -> None:
        """Record what this contract owes `recipient`. Never pushes value.

        Settlement credits rather than pays, and the reason is measured rather
        than stylistic. `emit_transfer` **does not credit an externally-owned
        account**: to a wallet the value leaves this contract and arrives
        nowhere, in both `on` modes. It credits a *contract* recipient
        correctly. Every provider, client and attester here is a wallet, so the
        old design -- five direct `emit_transfer` calls at the moment of
        settlement -- recorded settlement and moved no money.

        Splitting it in two fixes that. Crediting an entitlement is pure
        storage: it cannot fail, cannot be dropped by a consensus round, and is
        readable afterwards through `owed_to`. Moving the value is a separate,
        retryable call the recipient makes when it can receive it. The part that
        must not fail no longer depends on the part that can.
        """
        key = _owed_key(recipient)
        current = self.owed.get(key)
        total = (0 if current is None else int(current)) + int(amount)
        if total < 0 or total > U256_MAX:
            _fail("entitlement_overflow")
        # Plain int, never `u256(total)`. On the v0.3 runner the integer
        # aliases are `typing.Annotated[int, ...]` rather than `NewType`, so
        # they are annotations and not callables -- the wrapping still reads
        # as correct and still parses, and raises a TypeError once live.
        self.owed[key] = total
        self.total_owed = int(self.total_owed) + int(amount)

    def _contract_balance(self) -> int:
        """What this contract actually holds, as the chain sees it.

        The number `reclaim_in_flight` is decided against. Read rather than
        tracked, because a tracked figure is only as good as every path that
        touches value, and this one is the ground truth those paths are checked
        against.
        """
        return int(gl.get_contract_at(gl.message.contract_address).balance)

    @gl.public.write
    def assign_to(self, recipient: str) -> dict:
        """Hand your entitlement to another address. Moves no value.

        The safe half of the payout path, and the one a wallet should use.

        `emit_transfer` does not credit an externally owned account, and a
        transfer that cannot be delivered is not returned either -- measured on
        studionet, an `on="accepted"` transfer to a wallet left this contract's
        balance and arrived nowhere, and `__on_errored_message__` never fired.
        So any method that pushes value at an address it cannot verify is a
        method that can destroy money.

        This one pushes nothing. It debits `owed[caller]` and credits
        `owed[recipient]`, both pure storage, and the contract's balance does
        not change. If the recipient turns out to be unable to collect, the
        entitlement is still sitting there under its address, still readable
        through `owed_to`, still assignable onward. Nothing is destroyed, which
        is the property `withdraw` cannot offer.

        Authorisation is preserved by construction: the debited key is
        `gl.message.sender_address`, so the only entitlement a caller can move
        is its own. Naming a recipient decides where it goes, never whose it is.
        """
        to = recipient if isinstance(recipient, Address) else Address(recipient)
        if _owed_key(to) == _owed_key(gl.message.contract_address):
            _fail(REASON_SELF_PAYOUT)

        key = _owed_key(gl.message.sender_address)
        if _owed_key(to) == key:
            # A self-assignment is a no-op that would still emit a receipt
            # implying something happened. Refuse rather than mislead.
            _fail(REASON_SELF_PAYOUT)

        current = self.owed.get(key)
        amount = 0 if current is None else int(current)
        if amount <= 0:
            _fail(REASON_NOTHING_OWED)

        self.owed[key] = 0
        target = self.owed.get(_owed_key(to))
        total = (0 if target is None else int(target)) + amount
        if total > U256_MAX:
            _fail("entitlement_overflow")
        self.owed[_owed_key(to)] = total
        # `total_owed` is unchanged: this moves an obligation, it does not
        # create or discharge one.
        return {"from": key, "to": _owed_key(to), "amount": amount}

    @gl.public.write
    def reclaim_in_flight(self) -> dict:
        """Take back an entitlement whose payout never left this contract.

        `withdraw` cannot observe whether its emitted transfer arrived, so it
        does not pretend to: it moves the entitlement to `in_flight` and emits.
        This is the other half. It restores `in_flight` to `owed`, but only when
        the money is demonstrably still here.

        The test is solvency, and it is exact rather than heuristic. Obligations
        are `total_owed + total_in_flight` and do not change when `withdraw`
        moves an amount between them. So:

        * the transfer was never dispatched -- balance untouched, obligations
          still fully backed, and the entitlement is restored;
        * the transfer left, whether it arrived or was destroyed -- balance fell
          by exactly that amount, obligations are no longer backed, and this
          refuses with `value_already_left_the_contract`.

        Refusing the second case is the point, not a limitation. Value that has
        left cannot be conjured back by rewriting a ledger, and restoring the
        entitlement anyway would hand its owner a claim on money belonging to
        everyone else the contract owes.
        """
        key = _owed_key(gl.message.sender_address)
        current = self.in_flight.get(key)
        amount = 0 if current is None else int(current)
        if amount <= 0:
            _fail(REASON_NOTHING_IN_FLIGHT)

        obligations = int(self.total_owed) + int(self.total_in_flight)
        if self._contract_balance() < obligations:
            _fail(REASON_VALUE_ALREADY_LEFT)

        self.in_flight[key] = 0
        self.total_in_flight = int(self.total_in_flight) - amount
        owed_now = self.owed.get(key)
        self.owed[key] = (0 if owed_now is None else int(owed_now)) + amount
        self.total_owed = int(self.total_owed) + amount
        return {"owner": key, "restored": amount}

    @gl.public.write
    def withdraw(self, recipient_is_a_contract: bool = False) -> dict:
        """Claim an entitlement. The only method that moves value out.

        The caller must assert that it is a contract, because **this contract
        cannot check**, and the consequence of being wrong is losing the
        entitlement: the balance is zeroed before the transfer, which is not
        optional -- leaving it intact across the transfer would let a caller
        withdraw twice and drain the contract.

        The obvious guard does not work on GenLayer. On Ethereum
        `sender != origin` proves the caller is a contract; here an emitted
        cross-contract message arrives with `origin_address` **equal to**
        `sender_address`, both set to the calling contract, so the originating
        account is not carried through. A guard built on that comparison rejects
        the one path that actually works.

        What is left is to make the caller say it, and to refuse by default. A
        wallet calling `withdraw()` with no argument is turned away with its
        entitlement intact; losing it takes deliberately passing `True` while
        being wrong about your own address. That is not a proof and this
        docstring does not pretend otherwise -- it is the difference between a
        mistake anyone can make by accident and one you have to opt into.

        Lift the flag the moment `emit_transfer` credits wallets.
        """
        if not isinstance(recipient_is_a_contract, bool):
            _fail(REASON_WITHDRAW_NEEDS_CONTRACT)
        if not recipient_is_a_contract:
            _fail(REASON_WITHDRAW_NEEDS_CONTRACT)

        key = _owed_key(gl.message.sender_address)
        current = self.owed.get(key)
        amount = 0 if current is None else int(current)
        if amount <= 0:
            _fail(REASON_NOTHING_OWED)

        # Moved, not zeroed. Zeroing first is still required -- leaving the
        # entitlement readable across the transfer would let a caller withdraw
        # twice -- but discarding it outright makes an undeliverable payout
        # unrecoverable, which is the defect this split fixes. The obligation
        # survives in `in_flight`, and `reclaim_in_flight` returns it if the
        # value never actually left. Totals move together, so the contract's
        # obligations are unchanged by this step.
        self.owed[key] = 0
        self.total_owed = int(self.total_owed) - amount
        pending = self.in_flight.get(key)
        self.in_flight[key] = (0 if pending is None else int(pending)) + amount
        self.total_in_flight = int(self.total_in_flight) + amount
        # `on="accepted"`, not the SDK's safer-by-default `on="finalized"`.
        #
        # Measured on Bradbury: a transfer emitted `on="finalized"` is recorded
        # on the transaction and then never dispatched -- the claim reached
        # FINALIZED with an empty `triggered_transactions` and the value never
        # moved. The same probe with `on="accepted"` credited the recipient.
        #
        # The usual reason to prefer `finalized` is that an appealed transaction
        # can be overturned after the value has left. That risk is as low as it
        # gets here: `withdraw` runs no nondet block. It reads storage,
        # subtracts and emits -- a deterministic computation with nothing for
        # validators to disagree about, so an appeal re-runs it and reaches the
        # same answer. The appeal hazard belongs to payouts attached to a
        # *grade*, and settlement deliberately does not pay: it credits.
        gl.get_contract_at(gl.message.sender_address).emit_transfer(
            value=amount, on="accepted"
        )
        return {"to": key, "amount": amount}

    # --- views --------------------------------------------------------------

    @gl.public.view
    def in_flight_to(self, recipient: str) -> int:
        """An entitlement `withdraw` emitted but whose arrival is unobservable.

        Non-zero here means a payout was attempted and this contract cannot tell
        whether it landed. `reclaim_in_flight` resolves it: it restores the
        entitlement if the money is still here, and refuses if it is not.
        """
        if not isinstance(recipient, str):
            return 0
        got = self.in_flight.get(recipient.lower())
        return 0 if got is None else int(got)

    @gl.public.view
    def solvency(self) -> dict:
        """What this contract holds against what it owes.

        `backed` is the check `reclaim_in_flight` makes, exposed so it can be
        read before calling rather than discovered by a refusal. It is false
        exactly when value has left against an entitlement that was never
        confirmed delivered.
        """
        obligations = int(self.total_owed) + int(self.total_in_flight)
        held = self._contract_balance()
        return {
            "balance": held,
            "total_owed": int(self.total_owed),
            "total_in_flight": int(self.total_in_flight),
            "obligations": obligations,
            "backed": held >= obligations,
        }

    @gl.public.view
    def owed_to(self, recipient: str) -> int:
        """What this contract owes an address but has not yet paid out.

        Free to call, and the number a recipient checks before withdrawing.
        """
        if not isinstance(recipient, str):
            return 0
        # Lowercased to match `_owed_key`. An off-chain caller passes whichever
        # form it happens to hold -- a checksummed address from a wallet, a
        # lowercase one from a log -- and both must find the same entry.
        key = recipient.strip().lower()
        current = self.owed.get(key)
        return 0 if current is None else int(current)


    def _report(self, subject: Address) -> dict:
        """An agent's standing, recomputed from stored grades at read time.

        Decay is a function of age, so the score is derived per call rather than
        cached. Nothing here calls a model: the grades were settled when they
        were written.

        Private, and called from a write path as well as a read one:
        `accept_engagement` prices collateral off the same number `get_report`
        returns, and it must be the same number by construction rather than by
        two implementations agreeing. A `@gl.public.view` method is a call
        surface, not a subroutine, so the shared body lives here and both
        entry points are thin.
        """
        policy = self._policy()
        ids = self.subject_atts.get(subject)
        if ids is None:
            return Report(NEUTRAL_BP, 0, 0, 0, 0).as_dict()

        now = _now_seconds()
        entries = []
        attesters = []
        counted = 0
        for raw_id in ids:
            index = int(raw_id)
            weight = attestation_weight(
                substantiated=int(self.att_substantiated[index]),
                confidence=int(self.att_confidence[index]),
                repeat_index=int(self.att_repeat_index[index]),
                age_seconds=now - int(self.att_created_at[index]),
                policy=policy,
            )
            if weight > 0:
                counted += 1
            entries.append((weight, int(self.att_fulfilled[index])))
            who = normalize_address(self.att_attester[index].as_hex)
            if who not in attesters:
                attesters.append(who)

        score_bp, total_weight = aggregate(entries, policy)
        return Report(
            score_bp=score_bp,
            total_weight=total_weight,
            n_attestations=len(entries),
            n_distinct_attesters=len(attesters),
            n_counted=counted,
        ).as_dict()

    def _report(self, subject: Address) -> dict:
        """An agent's standing, recomputed from stored grades at read time.

        Decay is a function of age, so the score is derived per call rather than
        cached. Nothing here calls a model: the grades were settled when they
        were written.

        Private, and called from a write path as well as a read one:
        `accept_engagement` prices collateral off the same number `get_report`
        returns, and it must be the same number by construction rather than by
        two implementations agreeing. A `@gl.public.view` method is a call
        surface, not a subroutine, so the shared body lives here and both
        entry points are thin.
        """
        policy = self._policy()
        ids = self.subject_atts.get(subject)
        if ids is None:
            return Report(NEUTRAL_BP, 0, 0, 0, 0).as_dict()

        now = _now_seconds()
        entries = []
        attesters = []
        counted = 0
        for raw_id in ids:
            index = int(raw_id)
            weight = attestation_weight(
                substantiated=int(self.att_substantiated[index]),
                confidence=int(self.att_confidence[index]),
                repeat_index=int(self.att_repeat_index[index]),
                age_seconds=now - int(self.att_created_at[index]),
                policy=policy,
            )
            if weight > 0:
                counted += 1
            entries.append((weight, int(self.att_fulfilled[index])))
            who = normalize_address(self.att_attester[index].as_hex)
            if who not in attesters:
                attesters.append(who)

        score_bp, total_weight = aggregate(entries, policy)
        return Report(
            score_bp=score_bp,
            total_weight=total_weight,
            n_attestations=len(entries),
            n_distinct_attesters=len(attesters),
            n_counted=counted,
        ).as_dict()

    @gl.public.view
    def get_report(self, subject: Address) -> dict:
        """An agent's standing. The number collateral is priced off."""
        return self._report(subject)

    @gl.public.view
    def get_attestation(self, attestation_id: u256) -> dict:
        """One attestation, with the weight it carries as of now."""
        index = int(attestation_id)
        if index < 0 or index >= len(self.att_engagement):
            _fail("no_such_attestation")

        policy = self._policy()
        now = _now_seconds()
        age = now - int(self.att_created_at[index])
        return {
            "id": index,
            "engagement_id": self.att_engagement[index],
            "attester": self.att_attester[index].as_hex,
            "subject": self.att_subject[index].as_hex,
            "claim": self.att_claim[index],
            "evidence": self.att_evidence[index],
            "created_at": int(self.att_created_at[index]),
            "age_seconds": age,
            "verdict": self.att_verdict[index],
            "fulfilled": int(self.att_fulfilled[index]),
            "substantiated": int(self.att_substantiated[index]),
            "confidence": int(self.att_confidence[index]),
            "repeat_index": int(self.att_repeat_index[index]),
            "bond": int(self.att_bond[index]),
            "bond_state": self.att_bond_state[index],
            "weight": attestation_weight(
                substantiated=int(self.att_substantiated[index]),
                confidence=int(self.att_confidence[index]),
                repeat_index=int(self.att_repeat_index[index]),
                age_seconds=age,
                policy=policy,
            ),
        }

    @gl.public.view
    def get_subject_attestations(
        self, subject: Address, offset: u256 = 0, limit: u256 = _PAGE_MAX
    ) -> list:
        """Attestation ids about one subject, oldest first, one page at a time.

        Paged because the list is append-only and unbounded: nothing stops a
        subject from accumulating more attestations than a single response can
        carry, and an unpaged view would eventually stop answering at all for the
        agent with the longest history - which is the agent whose page matters
        most. `limit` is clamped rather than rejected so a caller asking for
        everything gets the maximum instead of an error.
        """
        ids = self.subject_atts.get(subject)
        if ids is None:
            return []
        return [int(raw) for raw in _slice(ids, int(offset), int(limit))]

    @gl.public.view
    def get_attestations(self, offset: u256 = 0, limit: u256 = _PAGE_MAX) -> list:
        """One page of attestations, newest-agnostic, in id order.

        Exists so a client can build the registry without one call per
        attestation. Walking `attestation_count()` and reading each id
        individually costs `2 + N + E + S` requests for a list of `N`, which
        exhausts a public RPC's per-minute budget at a couple of dozen
        attestations - the point at which the registry becomes worth looking at.
        This collapses the `N` and the `E` into `ceil(N / _PAGE_MAX)`.

        `evidence` is deliberately absent. It is by far the largest stored field
        (`MAX_EVIDENCE_CHARS` is 6000, four times the claim) and no list view
        shows it; a caller that needs it is looking at one attestation and can
        afford `get_attestation`. Everything the registry does render - including
        the committed scope and its digest, which it searches - is here.
        """
        policy = self._policy()
        now = _now_seconds()
        return [
            self._summarize(index, policy, now)
            for index in _slice(range(len(self.att_engagement)), int(offset), int(limit))
        ]

    def _summarize(self, index: int, policy: Policy, now: int) -> dict:
        """One attestation as the list views return it.

        Shared by both paged views so they cannot drift into returning different
        shapes for the same record, which a client decoding one with the other's
        expectations would only discover at a missing field.

        Everything `get_attestation` returns except `evidence`: it is the largest
        stored field by a wide margin and no list renders it, so carrying it
        would multiply every page's size for nothing.
        """
        engagement_id = self.att_engagement[index]
        age = now - int(self.att_created_at[index])
        return {
            "id": index,
            "engagement_id": engagement_id,
            "attester": self.att_attester[index].as_hex,
            "subject": self.att_subject[index].as_hex,
            "claim": self.att_claim[index],
            "scope": self.eng_scope[engagement_id],
            "scope_digest": self.eng_digest[engagement_id],
            "created_at": int(self.att_created_at[index]),
            "age_seconds": age,
            "verdict": self.att_verdict[index],
            "fulfilled": int(self.att_fulfilled[index]),
            "substantiated": int(self.att_substantiated[index]),
            "confidence": int(self.att_confidence[index]),
            "repeat_index": int(self.att_repeat_index[index]),
            "bond": int(self.att_bond[index]),
            "bond_state": self.att_bond_state[index],
            "weight": attestation_weight(
                substantiated=int(self.att_substantiated[index]),
                confidence=int(self.att_confidence[index]),
                repeat_index=int(self.att_repeat_index[index]),
                age_seconds=age,
                policy=policy,
            ),
        }

    @gl.public.view
    def get_subject_page(
        self, subject: Address, offset: u256 = 0, limit: u256 = _PAGE_MAX
    ) -> list:
        """One page of attestations about a single subject.

        The same records as `get_attestations`, reached through the per-subject
        index instead of the global one, so an agent's page costs a request per
        page of *its own* history rather than one per attestation plus one per
        engagement.
        """
        ids = self.subject_atts.get(subject)
        if ids is None:
            return []
        return [
            self._summarize(int(raw), self._policy(), _now_seconds())
            for raw in _slice(ids, int(offset), int(limit))
        ]

    @gl.public.view
    def get_reports(self, subjects: list) -> list:
        """Standing for several agents in one call.

        The companion to `get_attestations`: having grouped a page of
        attestations by subject, a client needs one score per subject, and
        asking for them one at a time puts the per-request count straight back
        where the batch view removed it.

        Capped like every other page. Each entry carries its own `subject` so a
        caller does not have to rely on positional correspondence.
        """
        out = []
        for raw in _slice(subjects, 0, len(subjects)):
            subject = Address(raw) if not isinstance(raw, Address) else raw
            report = self._report(subject)
            report["subject"] = subject.as_hex
            out.append(report)
        return out

    @gl.public.view
    def get_engagement(self, engagement_id: str) -> dict:
        """The committed scope, its digest, and the collateral behind the work.

        `collateral` is what the provider actually posted; `score_bp` and
        `rate_bp` are the standing it was priced at and the rate that standing
        bought, kept so the figure can be re-derived by anyone reading the
        engagement rather than taken on faith. All three are zero on a proposal
        nobody has accepted yet.
        """
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)
        return {
            "id": engagement_id,
            "client": self.eng_client[engagement_id].as_hex,
            "provider": self.eng_provider[engagement_id].as_hex,
            "scope": self.eng_scope[engagement_id],
            "scope_digest": self.eng_digest[engagement_id],
            # `state` is the surface to branch on; `closed` is kept because it
            # reads well and predates the proposal state, but it cannot express
            # the difference between a proposal and accepted work.
            "state": _ENG_STATE_NAMES[int(state)],
            "closed": int(state) == _ENG_CLOSED,
            "stake": int(self.eng_stake.get(engagement_id, 0)),
            "closed_at": int(self.eng_closed_at.get(engagement_id, 0)),
            "collateral": int(self.eng_collateral.get(engagement_id, 0)),
            "collateral_state": self.eng_collateral_state.get(engagement_id, _COL_NONE),
            "collateral_rate_bp": int(self.eng_collateral_rate_bp.get(engagement_id, 0)),
            "score_bp": int(self.eng_score_bp.get(engagement_id, 0)),
        }

    @gl.public.view
    def get_policy(self) -> dict:
        """The deployed parameters, so a client never has to assume them."""
        policy = self._policy()
        return {
            "half_life_seconds": policy.half_life_seconds,
            "prior_weight": policy.prior_weight,
            "min_substantiated": policy.min_substantiated,
            "min_confidence": policy.min_confidence,
            "confidence_tol": policy.confidence_tol,
            "repeat_shift_cap": policy.repeat_shift_cap,
            "min_bond": policy.min_bond,
            "slash_floor": policy.slash_floor,
            "release_floor": policy.release_floor,
            "bond_lock_seconds": policy.bond_lock_seconds,
            "collateral_ceiling_bp": policy.collateral_ceiling_bp,
            "collateral_floor_bp": policy.collateral_floor_bp,
            "collateral_forfeit_bp": policy.collateral_forfeit_bp,
        }

    @gl.public.view
    def attestation_count(self) -> u256:
        return len(self.att_engagement)

    @gl.public.view
    def collateral_quote(self, provider: Address, stake: u256) -> dict:
        """What taking on work worth `stake` would cost this agent, right now.

        The read-side twin of the gate in `accept_engagement`, and the reason a
        provider never has to discover the price from a rejection. It carries the
        score and the rate as well as the amount, because the amount alone is a
        demand and the three together are an explanation: this is your standing,
        this is what that standing costs, this is the money.

        A quote is only as fresh as the score behind it - one more attestation
        about this provider moves it - so a caller that sends value should re-read
        it at submit time, exactly as the bond quote is re-read.
        """
        policy = self._policy()
        score_bp = int(self._report(provider)["score_bp"])
        declared = int(stake)
        return {
            "provider": provider.as_hex,
            "stake": declared,
            "score_bp": score_bp,
            "rate_bp": collateral_rate_bp(score_bp, policy),
            "required": collateral_required(score_bp, declared, policy),
            "max_stake": max_stake(policy),
        }

    @gl.public.view
    def bond_for_next(self, attester: Address, subject: Address) -> u256:
        """What the next attestation from this attester about this subject costs.

        Exposed so a client can quote the price before sending value, rather than
        discovering it from a rejection.
        """
        pair = _pair_key(attester, subject)
        repeat_index = int(self.pair_count.get(pair, 0))
        return bond_required(repeat_index, self._policy())
