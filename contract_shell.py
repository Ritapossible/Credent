"""GenLayer contract layer for the reputation oracle.

This file is the *shell*: everything that talks to the chain, and nothing that
decides a number. `build_contract.py` splices the deterministic engine
(`reputation_core.py`) and the prompt builder (`reputation_prompts.py`) into the
marker below and writes `reputation_oracle.py`, which is the single file that
actually deploys. Editing the generated file directly is a mistake - it is
overwritten, and `test_build_contract.py` fails when it drifts.

The split is deliberate. The engine is 245 tests of pure integer arithmetic that
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
releasable one is reclaimed by the attester after the lock elapses. Nothing
transfers implicitly during grading, so a failed nondet round cannot strand or
duplicate a payment.

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

    # Engagements, keyed by a caller-supplied id.
    eng_client: TreeMap[str, Address]
    eng_provider: TreeMap[str, Address]
    eng_scope: TreeMap[str, str]
    eng_digest: TreeMap[str, str]
    eng_state: TreeMap[str, u256]

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

    # Indexes.
    subject_atts: TreeMap[Address, DynArray[u256]]
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
        )

    # --- engagements --------------------------------------------------------

    @gl.public.write
    def open_engagement(self, engagement_id: str, provider: Address, scope: str) -> None:
        """Commit a scope before the work starts.

        The digest is taken here, at open time, which is the whole point: once
        the outcome is known neither party can retrofit the standard being graded
        against. The scope text is stored alongside it so the grading prompt can
        be rebuilt byte-identically by every validator later.
        """
        if not engagement_id or len(engagement_id) > _MAX_ID_CHARS:
            _fail("bad_engagement_id")
        if self.eng_state.get(engagement_id, _ENG_ABSENT) != _ENG_ABSENT:
            _fail("engagement_exists")
        if not scope.strip():
            _fail("empty_scope")

        client = gl.message.sender_address
        if provider == client:
            _fail("provider_is_client")

        self.eng_client[engagement_id] = client
        self.eng_provider[engagement_id] = provider
        self.eng_scope[engagement_id] = scope
        self.eng_digest[engagement_id] = scope_digest(scope)
        # Proposed, not open. The provider named above has not agreed to anything
        # yet, and until they do nothing about this engagement can reach a score.
        self.eng_state[engagement_id] = _ENG_PROPOSED

    @gl.public.write
    def accept_engagement(self, engagement_id: str) -> None:
        """Agree to be graded on a scope someone proposed for you.

        The consent step, and the reason attestation cannot be used to defame a
        stranger. Only the named provider can call it: the client already
        consented by opening, and letting either side accept would make the
        signature meaningless.

        The scope is fixed by now and its digest is committed, so accepting is an
        agreement to a specific standard rather than an open-ended one - the
        provider can read exactly what they are agreeing to be measured against.
        """
        state = self.eng_state.get(engagement_id, _ENG_ABSENT)
        if state == _ENG_ABSENT:
            _fail(REASON_NO_ENGAGEMENT)
        if state != _ENG_PROPOSED:
            _fail(REASON_ALREADY_ACCEPTED)
        if gl.message.sender_address != self.eng_provider[engagement_id]:
            _fail(REASON_NOT_PROVIDER)

        self.eng_state[engagement_id] = _ENG_OPEN

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

        # Overpayment is returned immediately. Holding it would make the bond
        # curve a floor rather than a price, and the curve is the argument.
        excess = posted - required
        if excess > 0:
            # `value` is keyword-only here, and `emit_transfer` raises on a
            # non-positive amount -- hence the guard above rather than an
            # unconditional call.
            gl.get_contract_at(attester).emit_transfer(value=excess)

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
        gl.get_contract_at(attester).emit_transfer(value=amount)

    # --- views --------------------------------------------------------------

    @gl.public.view
    def get_report(self, subject: Address) -> dict:
        """An agent's standing, recomputed from stored grades at read time.

        Decay is a function of age, so the score is derived per call rather than
        cached. Nothing here calls a model: the grades were settled when they
        were written.
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
            report = self.get_report(subject)
            report["subject"] = subject.as_hex
            out.append(report)
        return out

    @gl.public.view
    def get_engagement(self, engagement_id: str) -> dict:
        """The committed scope and its digest."""
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
        }

    @gl.public.view
    def attestation_count(self) -> u256:
        return len(self.att_engagement)

    @gl.public.view
    def bond_for_next(self, attester: Address, subject: Address) -> u256:
        """What the next attestation from this attester about this subject costs.

        Exposed so a client can quote the price before sending value, rather than
        discovering it from a rejection.
        """
        pair = _pair_key(attester, subject)
        repeat_index = int(self.pair_count.get(pair, 0))
        return bond_required(repeat_index, self._policy())
