"""Deterministic engine for the agent reputation oracle.

Everything here is pure integer arithmetic over basis points, runs identically
on every validator, and needs no GenLayer runtime to test. The contract
(`reputation_oracle.py`) inlines this module verbatim; this file is the source
of truth and what the test suite exercises.

The split this module encodes:

  the model judges   - `fulfilled` (did the work match the committed scope?)
                       and `substantiated` (does the evidence support that
                       claim, or is it bare assertion?)
  the code judges    - what those two numbers are *worth*: decay, repeat-attester
                       damping, shrinkage toward a neutral prior, and whether the
                       attester's bond comes back.

`substantiated` is the weight, not a second opinion. An attestation nobody
evidenced barely moves the score no matter how glowing it is, which is what makes
shilling unprofitable without anyone having to detect it.

No floats appear anywhere in this file, deliberately. A float would let two
validators disagree in the last bit and turn a rounding artifact into a consensus
failure.
"""

from __future__ import annotations

import calendar
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

# Basis points. All ratios in this module are integers out of 10000; there is no
# floating point anywhere in the deterministic path.
BP = 10000

# Neutral score, applied to an agent with no history and used as the shrinkage
# target. Deliberately the midpoint: an unknown agent is neither endorsed nor
# suspect, and the prior must not be reachable as a "real" grade only from below.
NEUTRAL_BP = 5000

# Widest value the contract's `u256` storage fields can hold. Amounts and
# timestamps arrive as unbounded Python ints -- calldata decodes integers at
# arbitrary precision -- so the boundary that writes them to storage has to check
# the range itself. Without that check an out-of-range value faults inside
# `u256()`, which is an unclassified failure validators cannot compare, instead of
# a classified rejection every node derives identically.
U256_MAX = (1 << 256) - 1

# Widest collateral rate a policy may charge: a hundred times the stake. A rate
# is a multiplier on money someone has to find before they can take on work, so
# it is bounded for the same reason `repeat_shift_cap` is - a parameter that can
# be set to anything can be set to a number that stops the protocol working, and
# a deployment discovers that at the first acceptance rather than at deploy time.
MAX_COLLATERAL_BP = 100 * BP

# Past this many half-lives an attestation's weight has underflowed to zero in
# integer arithmetic anyway, and `w >> periods` with a large shift is wasted work
# at best. Bounded so a hostile or corrupt timestamp cannot produce a huge shift.
_MAX_HALVINGS = 63


# --- error classification -------------------------------------------------

# Validators have to reach consensus on failures, not just on successes, so a
# raised message carries a class prefix telling the validator how to compare it.
#
# The whole vocabulary is declared even though this contract only ever raises
# `[EXPECTED]`. The prefixes are a protocol shared with validator code rather
# than private strings: a validator that meets an `[EXTERNAL]` or `[TRANSIENT]`
# message needs the comparison rule already defined, not inferred at the point of
# failure. `[LLM_ERROR]` names the rule `validator_fn` already implements by
# returning False on unusable leader output -- disagree, and force rotation.
ERROR_EXPECTED = "[EXPECTED]"  # deterministic business logic -- must match exactly
ERROR_EXTERNAL = "[EXTERNAL]"  # external 4xx, deterministic -- must match exactly
ERROR_TRANSIENT = "[TRANSIENT]"  # network/5xx, non-deterministic -- both agree
ERROR_LLM = "[LLM_ERROR]"  # model misbehavior -- always disagree, force rotation

ERROR_PREFIXES = (ERROR_EXPECTED, ERROR_EXTERNAL, ERROR_TRANSIENT, ERROR_LLM)


def error_class(message: object) -> str:
    """The classification prefix on a raised message, or `""` if unprefixed.

    Total by construction: a non-string, or a message from code that predates the
    prefixes, classifies as `""` and is treated as unknown by `errors_agree`. An
    unclassified failure must never read as agreement.
    """
    if not isinstance(message, str):
        return ""
    for prefix in ERROR_PREFIXES:
        if message.startswith(prefix):
            return prefix
    return ""


def errors_agree(leader_msg: object, validator_msg: object) -> bool:
    """Whether two failed executions represent the same failure.

    The comparison rule per class, following the runner's own semantics:

    - `[EXPECTED]` / `[EXTERNAL]` are deterministic. Every honest node derives the
      same message from the same state, so they must match exactly.
    - `[TRANSIENT]` is not reproducible. Two nodes that both hit a transient
      failure agree that the call failed, without agreeing on the text.
    - `[LLM_ERROR]` and anything unclassified disagree, which forces rotation
      rather than freezing an unexplained failure into consensus.
    """
    leader_class = error_class(leader_msg)
    if leader_class != error_class(validator_msg):
        return False
    if leader_class in (ERROR_EXPECTED, ERROR_EXTERNAL):
        return leader_msg == validator_msg
    if leader_class == ERROR_TRANSIENT:
        return True
    return False


# Reason codes are part of the public surface: consumers branch on them and they
# are written into stored history, so they are stable strings rather than
# free-form prose.
REASON_NO_ENGAGEMENT = "no_such_engagement"
REASON_NOT_CLOSED = "engagement_not_closed"
REASON_NOT_COUNTERPARTY = "sender_not_counterparty"
REASON_ALREADY_ATTESTED = "already_attested"
REASON_BOND_TOO_SMALL = "bond_below_required"
REASON_GRADED = "graded"

# Consent. An engagement names a provider who never asked to be named, so it
# starts as a proposal and becomes real only when that provider accepts it.
# Without this an attacker could name any address as their counterparty, close
# the engagement alone, and attest about a victim who never participated - the
# bond is a price on that, not a bar to it.
REASON_NOT_ACCEPTED = "engagement_not_accepted"
REASON_NOT_PROVIDER = "sender_not_provider"
REASON_ALREADY_ACCEPTED = "engagement_already_accepted"

# Work collateral. Accepting an engagement is the moment an agent puts its
# reputation behind work, so it is the moment the score is converted into money
# at risk: `collateral_required` prices it, and the contract refuses an
# acceptance that arrives underfunded.
REASON_STAKE_OUT_OF_RANGE = "stake_out_of_range"
REASON_COLLATERAL_TOO_SMALL = "collateral_below_required"
REASON_NO_COLLATERAL = "no_collateral_posted"
REASON_COLLATERAL_HELD = "collateral_still_held"
REASON_COLLATERAL_FORFEITED = "collateral_forfeited"
REASON_COLLATERAL_NOT_FORFEITED = "collateral_not_forfeited"
REASON_COLLATERAL_SETTLED = "collateral_already_settled"
REASON_NOT_CLIENT = "sender_not_client"
REASON_NOTHING_OWED = "nothing_owed"
REASON_WITHDRAW_NEEDS_CONTRACT = "withdraw_recipient_must_be_a_contract"
REASON_SELF_PAYOUT = "recipient_is_this_contract"
REASON_RECIPIENT_UNPROVEN = "recipient_has_not_proven_it_can_receive"
REASON_ALREADY_PROVEN = "recipient_already_proven"
REASON_BAD_RECIPIENT = "recipient_is_not_an_address"
REASON_ZERO_RECIPIENT = "recipient_is_the_zero_address"

REASONS = frozenset({
    REASON_NO_ENGAGEMENT,
    REASON_NOT_CLOSED,
    REASON_NOT_COUNTERPARTY,
    REASON_ALREADY_ATTESTED,
    REASON_BOND_TOO_SMALL,
    REASON_GRADED,
    REASON_NOT_ACCEPTED,
    REASON_NOT_PROVIDER,
    REASON_ALREADY_ACCEPTED,
    REASON_STAKE_OUT_OF_RANGE,
    REASON_COLLATERAL_TOO_SMALL,
    REASON_NO_COLLATERAL,
    REASON_COLLATERAL_HELD,
    REASON_COLLATERAL_FORFEITED,
    REASON_COLLATERAL_NOT_FORFEITED,
    REASON_COLLATERAL_SETTLED,
    REASON_NOT_CLIENT,
    REASON_NOTHING_OWED,
    REASON_WITHDRAW_NEEDS_CONTRACT,
    REASON_SELF_PAYOUT,
    REASON_RECIPIENT_UNPROVEN,
    REASON_ALREADY_PROVEN,
    REASON_BAD_RECIPIENT,
    REASON_ZERO_RECIPIENT,
})


def normalize_address(text: str) -> str:
    """Canonical comparison form for an address.

    Case-folded and stripped so that a checksummed hex string and its lowercase
    spelling land in the same bucket. Not validated as an address -- the contract
    layer owns that, using the SDK's own parser.
    """
    if not isinstance(text, str):
        return ""
    return text.strip().casefold()


def parse_block_time(raw: object) -> int:
    """Consensus block time as whole epoch seconds, UTC.

    The runtime hands the block time over as a *string* -- the message is plain
    calldata, whose decoded types are None/int/str/bytes/list/dict, with no
    datetime among them. Parsing it is therefore the contract's job, and the
    timezone is the part that matters: a timestamp with no offset, read with the
    host's local zone, makes two validators in two zones derive epoch seconds that
    differ by hours. The same attestation would then decay by a different amount
    on each node, and the score would stop being a consensus-safe number. A
    missing offset is pinned to UTC rather than left to the host.

    Integer-only, like the rest of this module: `calendar.timegm` on a UTC
    timetuple avoids `.timestamp()`'s float round trip entirely.

    An int is accepted as-is so a future runner that sends epoch seconds directly
    needs no change here. Anything unparseable raises -- every validator sees the
    same string, so they all fail identically, and inventing a fallback time would
    silently corrupt decay accounting instead.
    """
    if isinstance(raw, bool):
        raise ValueError("block time must not be a bool")
    if isinstance(raw, int):
        return raw
    if not isinstance(raw, str):
        raise ValueError(f"block time must be a string or int, got {type(raw).__name__}")

    text = raw.strip()
    if not text:
        raise ValueError("block time is empty")
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"

    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        # A bare integer-as-string is still an unambiguous instant.
        try:
            return int(text)
        except ValueError:
            raise ValueError(f"unparseable block time: {raw!r}") from None

    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return calendar.timegm(moment.astimezone(timezone.utc).timetuple())


# --- policy ---------------------------------------------------------------


@dataclass(frozen=True)
class Policy:
    """Scoring and bonding parameters.

    half_life_seconds  - age at which an attestation's weight halves
    prior_weight       - strength of the neutral prior, in the same units as an
                         attestation's weight. Larger means slower to trust.
    min_substantiated  - below this, an attestation contributes no weight at all
    min_confidence     - below this, likewise
    confidence_tol     - allowed leader/validator spread on each graded field
    repeat_shift_cap   - largest repeat-damping shift, so weight cannot underflow
                         to zero purely from one attester being prolific
    min_bond           - bond required for a first attestation, base units
    slash_floor        - substantiated below this slashes the bond
    release_floor      - substantiated at or above this releases it in full
    bond_lock_seconds  - how long a releasable bond stays locked before reclaim

    The last three price *work collateral*, which is a different mechanism from
    the bond above and the one the score actually feeds:

    collateral_ceiling_bp - collateral an agent scoring 0 must post, in basis
                            points of the engagement's stake
    collateral_floor_bp   - what the same stake costs an agent scoring 10000.
                            The distance between the two is what a reputation is
                            worth in working capital.
    collateral_forfeit_bp - `fulfilled` below this forfeits the collateral to the
                            client, provided the attestation that says so is
                            itself substantiated enough to count in the score.

    `slash_floor <= release_floor` is enforced rather than assumed: inverted, the
    two bands would overlap and a single grade could be both slashable and
    releasable, which `bond_outcome` would have to break arbitrarily.
    `collateral_floor_bp <= collateral_ceiling_bp` is enforced for the same class
    of reason: inverted, the collateral curve would rise with reputation and the
    protocol would charge its best agents the most.
    """

    half_life_seconds: int = 7776000  # 90 days
    prior_weight: int = 3 * BP
    min_substantiated: int = 25
    min_confidence: int = 50
    confidence_tol: int = 20
    repeat_shift_cap: int = 8
    min_bond: int = 0
    slash_floor: int = 20
    release_floor: int = 50
    bond_lock_seconds: int = 1209600  # 14 days
    collateral_ceiling_bp: int = 15000  # 150% of stake at score 0
    collateral_floor_bp: int = 2500  # 25% of stake at a perfect score
    collateral_forfeit_bp: int = 2500  # fulfilled below 25% forfeits

    def validate(self) -> None:
        if self.half_life_seconds < 1:
            raise ValueError("half_life_seconds must be >= 1")
        if self.prior_weight < 0:
            raise ValueError("prior_weight must be >= 0")
        if not 0 <= self.min_substantiated <= 100:
            raise ValueError("min_substantiated out of range")
        if not 0 <= self.min_confidence <= 100:
            raise ValueError("min_confidence out of range")
        if not 0 <= self.confidence_tol <= 100:
            raise ValueError("confidence_tol out of range")
        if not 0 <= self.repeat_shift_cap <= _MAX_HALVINGS:
            raise ValueError("repeat_shift_cap out of range")
        if self.min_bond < 0:
            raise ValueError("min_bond must be >= 0")
        if not 0 <= self.slash_floor <= 100:
            raise ValueError("slash_floor out of range")
        if not 0 <= self.release_floor <= 100:
            raise ValueError("release_floor out of range")
        if self.slash_floor > self.release_floor:
            raise ValueError("slash_floor must be <= release_floor")
        if self.bond_lock_seconds < 0:
            raise ValueError("bond_lock_seconds must be >= 0")
        if not 0 <= self.collateral_ceiling_bp <= MAX_COLLATERAL_BP:
            raise ValueError("collateral_ceiling_bp out of range")
        if not 0 <= self.collateral_floor_bp <= MAX_COLLATERAL_BP:
            raise ValueError("collateral_floor_bp out of range")
        if self.collateral_floor_bp > self.collateral_ceiling_bp:
            raise ValueError("collateral_floor_bp must be <= collateral_ceiling_bp")
        if not 0 <= self.collateral_forfeit_bp <= BP:
            raise ValueError("collateral_forfeit_bp out of range")


# --- decay ----------------------------------------------------------------


def decay_bp(weight: int, age_seconds: int, half_life_seconds: int) -> int:
    """Exponential decay by half-life, in integer arithmetic.

    Whole halvings are a bit-shift; the remainder is linearly interpolated
    *between* the two neighbouring halvings rather than truncated to the lower
    one. Truncating would make the curve a staircase, so an attestation would hold
    its full weight for 90 days and then lose half of it in one second -- and an
    agent could time a submission around the cliff.

        periods = age // half_life
        hi = w >> periods           # weight at the start of this step
        lo = w >> (periods + 1)     # weight at the end of it
        result = hi - (hi - lo) * rem // half_life

    Monotonically non-increasing in age, exactly `weight` at age 0, and identical
    on every validator because there is no float in it.

    Negative ages are clamped to 0: a stored timestamp newer than the current
    block time is clock skew, not evidence that an attestation is more valuable
    than when it was written.
    """
    if half_life_seconds < 1:
        raise ValueError("half_life_seconds must be >= 1")
    if weight <= 0:
        return 0
    if age_seconds <= 0:
        return weight

    periods = age_seconds // half_life_seconds
    if periods > _MAX_HALVINGS:
        return 0

    remainder = age_seconds % half_life_seconds
    hi = weight >> periods
    lo = weight >> (periods + 1)
    return hi - ((hi - lo) * remainder) // half_life_seconds


def repeat_shift(repeat_index: int, policy: Policy) -> int:
    """Damping shift for the k-th attestation from one attester about one subject.

    The first (index 0) is undamped; each subsequent one is worth half the last,
    capped at `repeat_shift_cap` so a prolific-but-honest counterparty does not
    silently underflow to nothing.
    """
    if repeat_index <= 0:
        return 0
    return min(repeat_index, policy.repeat_shift_cap)


def attestation_weight(
    *,
    substantiated: int,
    confidence: int,
    repeat_index: int,
    age_seconds: int,
    policy: Policy,
) -> int:
    """What one attestation is worth, in basis points.

    Four factors, in order:

    1. **Floors.** Below `min_substantiated` or `min_confidence` the attestation
       carries no weight at all. It is still recorded -- the history stays
       auditable -- but it does not move the score. This is the anti-shill gate:
       an unevidenced rave is stored and ignored.
    2. **Substantiation.** The weight is proportional to it. Evidence quality is
       the weight, which is the whole design.
    3. **Repeat damping.** Halved per prior attestation from the same attester
       about the same subject.
    4. **Decay.** Halved per `half_life_seconds` of age.

    Confidence gates but does not scale, deliberately. It is the model's certainty
    about its own reading, not a property of the attestation, so letting it scale
    would make the score track model hesitancy as much as evidence.
    """
    policy.validate()

    if not isinstance(substantiated, int) or isinstance(substantiated, bool):
        return 0
    if not isinstance(confidence, int) or isinstance(confidence, bool):
        return 0
    if substantiated < policy.min_substantiated:
        return 0
    if confidence < policy.min_confidence:
        return 0

    base = (BP * max(0, min(100, substantiated))) // 100
    damped = base >> repeat_shift(repeat_index, policy)
    return decay_bp(damped, age_seconds, policy.half_life_seconds)


# --- aggregation ----------------------------------------------------------


@dataclass(frozen=True)
class Report:
    """An agent's standing, as reported to consumers."""

    score_bp: int
    total_weight: int
    n_attestations: int
    n_distinct_attesters: int
    n_counted: int

    def as_dict(self) -> dict:
        return {
            "score_bp": self.score_bp,
            "total_weight": self.total_weight,
            "n_attestations": self.n_attestations,
            "n_distinct_attesters": self.n_distinct_attesters,
            "n_counted": self.n_counted,
        }


def aggregate(entries: Iterable[tuple[int, int]], policy: Policy) -> tuple[int, int]:
    """Shrunk weighted mean of graded attestations.

    `entries` is (weight_bp, fulfilled_bp), already decayed and damped by
    `attestation_weight`. Returns (score_bp, total_weight).

        score = (sum(wi * gi) + prior_weight * NEUTRAL) / (sum(wi) + prior_weight)

    The prior is what stops a single attestation from producing a perfect agent.
    With the default `prior_weight` of 3 BP-units, one flawless well-evidenced
    review lands near 6250bp, not 10000 -- an agent has to accumulate corroborating
    history to climb, which is exactly the property a sybil cannot cheaply buy.

    An agent with no attestations at all scores exactly `NEUTRAL_BP`: unknown is
    distinct from bad, and a new agent must not be indistinguishable from one that
    was graded badly.
    """
    policy.validate()

    weighted_sum = 0
    total_weight = 0
    for weight, grade in entries:
        if weight <= 0:
            continue
        weighted_sum += weight * max(0, min(BP, grade))
        total_weight += weight

    denominator = total_weight + policy.prior_weight
    if denominator <= 0:
        return (NEUTRAL_BP, 0)

    numerator = weighted_sum + policy.prior_weight * NEUTRAL_BP
    return (numerator // denominator, total_weight)


# --- verdict vocabulary ---------------------------------------------------

VERDICT_FULFILLED = "fulfilled"
VERDICT_PARTIAL = "partial"
VERDICT_UNFULFILLED = "unfulfilled"
VERDICT_UNGRADED = "ungraded"

VERDICTS = (VERDICT_FULFILLED, VERDICT_PARTIAL, VERDICT_UNFULFILLED, VERDICT_UNGRADED)

# Every unusable response collapses to this exact dict. Two nodes that both refuse
# to read a response -- for different reasons, from different malformed output --
# still produce byte-identical grades, so agreement on a rejection is never in
# question.
#
# `substantiated: 0` means this carries zero weight. It does *not* slash: see
# `bond_outcome`, which reads the verdict before the number.
UNGRADED = {
    "verdict": VERDICT_UNGRADED,
    "fulfilled": NEUTRAL_BP,
    "substantiated": 0,
    "confidence": 0,
}


# --- bonding --------------------------------------------------------------

BOND_RELEASABLE = "releasable"
BOND_SLASHED = "slashed"
BOND_OUTCOMES = (BOND_RELEASABLE, BOND_SLASHED)


def bond_required(repeat_index: int, policy: Policy) -> int:
    """Bond for the k-th attestation from one attester about one subject.

    Doubles per repeat, mirroring the halving in `repeat_shift`. The two curves
    move in opposite directions on purpose: a sock-puppet farm pays geometrically
    more for attestations worth geometrically less, so the cost per unit of score
    moved rises as the square. That relationship is the whole economic argument
    and is asserted directly in the test suite.

    Capped at the same shift as the damping, so the bond cannot grow without bound
    for an honest counterparty with a long shared history.
    """
    policy.validate()
    if policy.min_bond <= 0:
        return 0
    return policy.min_bond << repeat_shift(repeat_index, policy)


def bond_outcome(grade: object, policy: Policy) -> str:
    """Whether the attester's bond comes back.

    Keyed on `substantiated`, never on `fulfilled`. Slashing a *negative* review
    would make honest criticism expensive and turn the oracle into a praise
    machine; slashing an *unsubstantiated* one charges for asserting without
    support, which is the actual sybil behaviour. A scathing, well-evidenced
    attestation is never at risk, and the test suite asserts that directly.

    An *ungraded* response releases the bond rather than slashing it. A response
    this contract could not read is evidence about this contract's own model, not
    about the attester, and confiscating for it would be unjust in a way that is
    not evenly distributed: malformed model output correlates with unusual input
    -- long technical excerpts, non-English text, odd formatting -- so the loss
    would fall hardest on legitimate attestations that merely fail to look
    typical. Nothing is lost in the lenient direction, because an attester who
    deliberately induced an unreadable grade would receive their bond back
    alongside an attestation of exactly zero weight, which is what they already
    had by not attesting at all.

    Total, and it fails toward release for the same reason: any input that is not
    a readable grade is a failure to establish that the attester asserted without
    support, and an unproven case does not justify taking their money.
    """
    policy.validate()
    if not isinstance(grade, dict):
        return BOND_RELEASABLE
    if grade.get("verdict") == VERDICT_UNGRADED:
        return BOND_RELEASABLE
    substantiated = grade.get("substantiated")
    if isinstance(substantiated, bool) or not isinstance(substantiated, int):
        return BOND_RELEASABLE
    return BOND_SLASHED if substantiated < policy.slash_floor else BOND_RELEASABLE


# --- work collateral ------------------------------------------------------
#
# This is the mechanism the score exists for, and it is not the bond above.
#
# The bond prices *attesting*: it is posted by an attester, doubles per repeat
# about the same subject, and answers "what does it cost to write a review".
# Collateral prices *working*: it is posted by the agent taking the job, falls as
# that agent's score rises, and answers "how much of your own money has to sit
# behind the work before a counterparty will hand it to you". A protocol with
# only the first has priced its reviews and left reputation decorative --
# `score_bp` would be a number consumers read rather than a number that decides
# anything on chain.
#
# The two curves also point in opposite directions on purpose. The bond rises
# with repetition, so buying a reputation gets more expensive per unit of score;
# the collateral falls with reputation, so *having* one is worth money. An agent
# who bought their score paid the rising curve to reach a discount on the falling
# one, and the discount is capped by `collateral_floor_bp` - which is why the
# floor is a policy parameter rather than zero.

COLLATERAL_RELEASABLE = "releasable"
COLLATERAL_FORFEIT = "forfeit"
COLLATERAL_OUTCOMES = (COLLATERAL_RELEASABLE, COLLATERAL_FORFEIT)


def collateral_rate_bp(score_bp: int, policy: Policy) -> int:
    """Collateral rate for an agent at `score_bp`, in basis points of the stake.

    A straight line from `collateral_ceiling_bp` at a score of zero to
    `collateral_floor_bp` at a perfect one:

        rate = ceiling - (ceiling - floor) * score / BP

    Linear rather than a curve with more opinion in it, because every point on it
    has to be explainable to the agent being charged: at the defaults an unknown
    agent scoring the neutral 5000 posts 87.5% of the stake, a strong agent at
    8000 posts 50%, and the best possible record still posts a quarter. Nobody
    reaches zero collateral, however good their history - a reputation earns a
    discount, and a discount is not an exemption.

    Monotonically non-increasing in the score, and integer throughout. The score
    is clamped rather than trusted: `aggregate` cannot return anything outside
    [0, BP], but this function is also called with a score a caller supplied, and
    an out-of-range one must not price collateral outside the policy's own band.
    """
    policy.validate()

    if not isinstance(score_bp, int) or isinstance(score_bp, bool):
        score = 0  # unreadable standing is priced as no standing
    else:
        score = max(0, min(BP, score_bp))

    span = policy.collateral_ceiling_bp - policy.collateral_floor_bp
    return policy.collateral_ceiling_bp - (span * score) // BP


def collateral_required(score_bp: int, stake: int, policy: Policy) -> int:
    """What an agent at `score_bp` must post to take on work worth `stake`.

    The conversion the whole protocol is for: `get_report(...).score_bp` in,
    money at risk out. `stake` is the engagement's declared value in the chain's
    base units, committed by the client when the engagement is opened and agreed
    to by the provider in the act of accepting it - neither side can move it
    afterwards, so the price of accepting is fixed by the same commitment that
    fixes the scope.

    Rounds down, like every other ratio here. A rounding direction has to be
    chosen and down is the one that cannot make a call fail for an amount the
    caller was quoted exactly.

    Zero stake means zero collateral, which is what makes this backwards
    compatible with an engagement that never declares one: the collateral layer
    switches itself off rather than blocking the lifecycle, exactly as
    `min_bond = 0` switches the bond off.
    """
    policy.validate()

    if not isinstance(stake, int) or isinstance(stake, bool) or stake <= 0:
        return 0
    return (stake * collateral_rate_bp(score_bp, policy)) // BP


def max_stake(policy: Policy) -> int:
    """Largest stake whose collateral still fits in a `u256`.

    The ceiling rate can exceed BP - collateral above the value of the work is a
    legitimate policy for an agent with no record - so a stake that fits in
    storage does not imply that the collateral derived from it does. The contract
    checks a declared stake against this at open time, where a rejection is
    classified and cheap, rather than at accept time, where it would fault inside
    a `u256` conversion and produce a failure validators cannot compare.
    """
    policy.validate()

    rate = policy.collateral_ceiling_bp
    if rate <= BP:
        return U256_MAX
    return (U256_MAX * BP) // rate


def collateral_outcome(grade: object, policy: Policy) -> str:
    """Whether the provider's collateral comes back.

    Keyed on `fulfilled` - the opposite of `bond_outcome`, and for the opposite
    reason. The bond answers "did this attester assert without support", so it
    reads substantiation and never sentiment. The collateral answers "was the
    work delivered", which is exactly what `fulfilled` measures, and forfeiting
    it is the consequence a client is owed when it was not.

    Two gates stand in front of that, and both are the same gate the score
    applies: the attestation must be substantiated at or above `release_floor`
    and confident at or above `min_confidence`. An attestation that carries no
    weight in the score must not be able to take an agent's money either -
    otherwise the cheapest attack on this contract is an unevidenced accusation,
    which costs one bond and is worth zero to the score while being worth the
    whole collateral to the accuser.

    Total, and it fails toward release for the same reason `bond_outcome` does:
    anything that is not a readable, weighted, unfulfilled grade is a failure to
    establish that the work was not delivered, and an unproven case does not
    justify taking someone's money. An `ungraded` response - one this contract
    could not read - is evidence about the model, not about the provider.
    """
    policy.validate()

    if not isinstance(grade, dict):
        return COLLATERAL_RELEASABLE
    if grade.get("verdict") == VERDICT_UNGRADED:
        return COLLATERAL_RELEASABLE

    substantiated = grade.get("substantiated")
    confidence = grade.get("confidence")
    fulfilled = grade.get("fulfilled")
    for value in (substantiated, confidence, fulfilled):
        if isinstance(value, bool) or not isinstance(value, int):
            return COLLATERAL_RELEASABLE

    if substantiated < policy.release_floor:
        return COLLATERAL_RELEASABLE
    if confidence < policy.min_confidence:
        return COLLATERAL_RELEASABLE
    return COLLATERAL_FORFEIT if fulfilled < policy.collateral_forfeit_bp else COLLATERAL_RELEASABLE


# --- verdict layer --------------------------------------------------------


def canonicalize_grade(raw: str | dict, policy: Policy) -> dict:
    """Coerce a model response into a bounded, canonical grade.

    Total function: every malformed, hostile, or out-of-range response becomes a
    definite grade rather than an exception, so leader and validators always agree
    on the coercion itself.

    Fails to *neutral and weightless*, not to a bad score. A model that returns
    garbage is evidence about the model, not about the agent being graded, so the
    agent's score must not move. This is the fail-closed direction for a
    reputation system: the harm to avoid is a score that moves on no evidence, in
    either direction.

    Accepts a JSON string or an already-parsed dict, because
    `gl.nondet.exec_prompt(..., response_format="json")` returns a dict.
    """
    policy.validate()

    if isinstance(raw, dict):
        parsed = raw
    else:
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return dict(UNGRADED)
    if not isinstance(parsed, dict):
        return dict(UNGRADED)

    verdict = parsed.get("verdict")
    if not isinstance(verdict, str):
        return dict(UNGRADED)
    verdict = verdict.strip().casefold()
    if verdict not in VERDICTS or verdict == VERDICT_UNGRADED:
        return dict(UNGRADED)

    # Bools are rejected rather than coerced throughout: `True == 1` in Python, so
    # accepting one would let a sloppy response read as a real score of 1.
    fulfilled = parsed.get("fulfilled")
    if isinstance(fulfilled, bool) or not isinstance(fulfilled, int):
        return dict(UNGRADED)
    substantiated = parsed.get("substantiated")
    if isinstance(substantiated, bool) or not isinstance(substantiated, int):
        return dict(UNGRADED)
    confidence = parsed.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, int):
        return dict(UNGRADED)

    return {
        "verdict": verdict,
        # `fulfilled` is a 0-100 score from the model, widened to basis points so
        # the aggregation arithmetic stays in one unit.
        "fulfilled": (BP * max(0, min(100, fulfilled))) // 100,
        "substantiated": max(0, min(100, substantiated)),
        "confidence": max(0, min(100, confidence)),
    }


def encode_grade(grade: dict) -> str:
    """Byte-stable encoding, so nodes that agree semantically agree bytewise."""
    return json.dumps(grade, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def decode_grade(raw: str | dict, policy: Policy) -> dict:
    """Inverse of `encode_grade`: read a grade that is *already* canonical.

    Kept separate from `canonicalize_grade` because the two take different units
    and only one of them may rescale. `canonicalize_grade` reads *model* output,
    whose `fulfilled` is a 0-100 score, and widens it to basis points. Putting an
    already-canonical grade back through it would widen a second time -- and since
    `min(100, 9000)` is 100, every grade above 100bp would saturate to a perfect
    10000.

    That path is reachable rather than theoretical. `encode_grade` exists so a
    grade can cross the leader/validator boundary as bytes, and a validator that
    re-canonicalized the leader's calldata would compare its own honest 4000
    against an apparent 10000 -- forcing rotation on agreeing nodes, or reading a
    failing grade as a flawless one. One function per direction is what keeps that
    from depending on every caller remembering which unit it holds.

    Total, and fails to `UNGRADED` for the same reason `canonicalize_grade` does:
    this reads untrusted calldata, so a malformed encoding has to produce a
    definite weightless grade rather than an exception validators cannot compare.
    """
    policy.validate()

    if isinstance(raw, dict):
        parsed = raw
    else:
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return dict(UNGRADED)
    if not isinstance(parsed, dict):
        return dict(UNGRADED)

    verdict = parsed.get("verdict")
    if not isinstance(verdict, str):
        return dict(UNGRADED)
    verdict = verdict.strip().casefold()
    if verdict not in VERDICTS or verdict == VERDICT_UNGRADED:
        return dict(UNGRADED)

    # Clamped, not rejected, matching `canonicalize_grade`: an out-of-range field
    # is a bounded value every node derives identically, and rejecting outright
    # would discard an otherwise readable grade over one bad integer.
    fields = {}
    for field, ceiling in (("fulfilled", BP), ("substantiated", 100), ("confidence", 100)):
        value = parsed.get(field)
        if isinstance(value, bool) or not isinstance(value, int):
            return dict(UNGRADED)
        fields[field] = max(0, min(ceiling, value))

    return {"verdict": verdict, **fields}


def grades_agree(mine: dict, theirs: dict, policy: Policy) -> bool:
    """Compare two grades field by field.

    Total, like `canonicalize_grade`, and for the same reason: `theirs` is the
    leader's calldata, which is untrusted input. A leader that reports
    `confidence` as a string would otherwise raise `TypeError` inside the
    validator -- an unclassified fault, not a disagreement -- so a malformed grade
    has to resolve to False rather than escape.

    `verdict` must match exactly; the three numbers carry a tolerance, because two
    different models reading the same evidence will not land on the same integer
    and demanding they do would make every round fail.

    Two `ungraded` results agree. Both nodes found the response unusable, which is
    a real agreement about a real outcome -- the alternative is rotating validators
    over a model that is reliably returning junk to all of them.
    """
    if not isinstance(mine, dict) or not isinstance(theirs, dict):
        return False

    verdict = mine.get("verdict")
    if verdict not in VERDICTS or verdict != theirs.get("verdict"):
        return False
    if verdict == VERDICT_UNGRADED:
        return True

    tol = policy.confidence_tol
    for field, scale in (("fulfilled", BP), ("substantiated", 100), ("confidence", 100)):
        a, b = mine.get(field), theirs.get(field)
        if isinstance(a, bool) or not isinstance(a, int):
            return False
        if isinstance(b, bool) or not isinstance(b, int):
            return False
        # The tolerance is expressed on a 0-100 scale, so a field stored in basis
        # points needs it widened to match rather than compared against a hundred
        # times too tight a bound.
        if abs(a - b) > (tol * scale) // 100:
            return False

    # Numbers within tolerance is not agreement if they settle the money
    # differently, and on their own they can.
    #
    # Both payouts are threshold functions of the numbers above, and the default
    # tolerance is wide enough to straddle either threshold. `bond_outcome` turns
    # on `substantiated < slash_floor`, a floor of 20 on a 0-100 scale against a
    # tolerance of 20: a leader reporting 10 and a validator computing 30 are
    # "within tolerance" while one confiscates the attester's bond and the other
    # returns it. `collateral_outcome` turns on `fulfilled < collateral_forfeit_bp`,
    # 2500bp against a tolerance of 2000bp: 1500 and 3500 agree by the numbers
    # while one hands the provider's collateral to the client and the other hands
    # it back.
    #
    # Tolerance exists because two models reading the same evidence will not land
    # on the same integer, and that is fine as long as they land on the same side
    # of every line that moves money. So the derived outcomes are compared too,
    # and a pair that crosses a threshold is a disagreement no matter how close
    # the numbers are.
    if bond_outcome(mine, policy) != bond_outcome(theirs, policy):
        return False
    if collateral_outcome(mine, policy) != collateral_outcome(theirs, policy):
        return False
    return True


# --- content addressing ---------------------------------------------------


def scope_digest(scope: str) -> str:
    """Content address of an engagement's scope.

    The scope is committed when the engagement opens, before the outcome is known,
    and this digest is what proves it did not change afterwards. Without it a
    disappointed client could retrofit the standard they are grading against.
    """
    payload = json.dumps(scope, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def attestation_salt(*, scope: str, attester: str, subject: str, claim: str) -> str:
    """Per-attestation fence salt for prompt construction.

    Derived from content rather than randomness, because every validator must
    build a byte-identical prompt. Unpredictable to the attester, since it commits
    to the scope digest they do not solely control.
    """
    material = "|".join([
        scope_digest(scope),
        normalize_address(attester),
        normalize_address(subject),
        claim,
    ])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()
