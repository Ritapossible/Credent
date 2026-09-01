"""Behavior tests for the deterministic scoring engine.

Pure Python, no GenLayer runtime needed -- everything under test is integer
arithmetic and total coercion, which is the whole reason the engine lives in its
own module.

The tests that matter most are the ones asserting *economic* properties rather
than arithmetic ones: that a sybil farm scores below distinct attesters, that
bond cost and attestation weight move in opposite directions, and that honest
criticism is never slashed. Those are the claims the design rests on, so they are
asserted directly rather than left to follow from the code being read carefully.
"""

from __future__ import annotations

import json

import pytest

import reputation_core as core

POLICY = core.Policy()
BP = core.BP
HALF_LIFE = POLICY.half_life_seconds


def weight(**kw) -> int:
    """`attestation_weight` with sensible defaults, so each test names only what
    it is varying."""
    return core.attestation_weight(
        substantiated=kw.pop("substantiated", 100),
        confidence=kw.pop("confidence", 100),
        repeat_index=kw.pop("repeat_index", 0),
        age_seconds=kw.pop("age_seconds", 0),
        policy=kw.pop("policy", POLICY),
    )


def grade(**kw) -> dict:
    """A well-formed model response, overridable field by field."""
    return {
        "verdict": kw.pop("verdict", core.VERDICT_FULFILLED),
        "fulfilled": kw.pop("fulfilled", 90),
        "substantiated": kw.pop("substantiated", 80),
        "confidence": kw.pop("confidence", 85),
        **kw,
    }


# --- error taxonomy -------------------------------------------------------


class TestErrorClass:
    @pytest.mark.parametrize("prefix", core.ERROR_PREFIXES)
    def test_recognizes_every_declared_prefix(self, prefix):
        assert core.error_class(f"{prefix} something went wrong") == prefix

    @pytest.mark.parametrize("junk", [None, 42, [], {}, b"bytes", 3.5, True])
    def test_non_strings_are_unclassified(self, junk):
        """Total by construction -- classification never raises on junk."""
        assert core.error_class(junk) == ""

    def test_unprefixed_message_is_unclassified(self):
        assert core.error_class("plain failure") == ""


class TestErrorsAgree:
    def test_identical_expected_messages_agree(self):
        msg = f"{core.ERROR_EXPECTED} engagement not closed"
        assert core.errors_agree(msg, msg)

    def test_differing_expected_messages_disagree(self):
        assert not core.errors_agree(
            f"{core.ERROR_EXPECTED} engagement not closed",
            f"{core.ERROR_EXPECTED} sender is not a counterparty",
        )

    def test_transient_agrees_without_matching_text(self):
        """Transient failures are not reproducible, so two nodes agree the call
        failed without agreeing on the wording."""
        assert core.errors_agree(
            f"{core.ERROR_TRANSIENT} upstream timeout",
            f"{core.ERROR_TRANSIENT} connection reset",
        )

    def test_llm_error_never_agrees_even_with_itself(self):
        """Model misbehavior must force rotation rather than freeze into
        consensus, so it disagrees even when both nodes report it identically."""
        msg = f"{core.ERROR_LLM} model returned prose"
        assert not core.errors_agree(msg, msg)

    def test_unclassified_never_agrees(self):
        assert not core.errors_agree("boom", "boom")

    def test_different_classes_disagree(self):
        assert not core.errors_agree(
            f"{core.ERROR_EXPECTED} x", f"{core.ERROR_TRANSIENT} x"
        )

    @pytest.mark.parametrize("junk", [None, 42, [], {}, object()])
    def test_total_against_junk(self, junk):
        assert core.errors_agree(junk, junk) is False
        assert core.errors_agree(f"{core.ERROR_EXPECTED} x", junk) is False


# --- address normalization ------------------------------------------------


class TestNormalizeAddress:
    def test_case_and_whitespace_collapse(self):
        assert core.normalize_address("  0xAbCd  ") == "0xabcd"

    def test_checksummed_and_lowercase_agree(self):
        mixed = "0xDeAdBeEf00000000000000000000000000000000"
        assert core.normalize_address(mixed) == core.normalize_address(mixed.lower())

    @pytest.mark.parametrize("junk", [None, 42, [], {}, b"0xabcd"])
    def test_non_strings_normalize_to_empty(self, junk):
        assert core.normalize_address(junk) == ""


# --- block time -----------------------------------------------------------


class TestParseBlockTime:
    def test_utc_suffix(self):
        assert core.parse_block_time("1970-01-01T00:00:00Z") == 0

    def test_explicit_offset_is_honored(self):
        """+01:00 at 01:00 is the epoch."""
        assert core.parse_block_time("1970-01-01T01:00:00+01:00") == 0

    def test_missing_offset_is_pinned_to_utc(self):
        """The load-bearing case. Read with a host-local zone instead, two
        validators in two zones derive epoch seconds hours apart and the same
        attestation decays by different amounts on each node."""
        assert core.parse_block_time("1970-01-01T00:00:00") == 0

    def test_naive_and_z_forms_agree(self):
        assert core.parse_block_time("2026-08-09T12:34:56") == core.parse_block_time(
            "2026-08-09T12:34:56Z"
        )

    def test_int_passes_through(self):
        assert core.parse_block_time(1754740000) == 1754740000

    def test_integer_string_is_accepted(self):
        assert core.parse_block_time("1754740000") == 1754740000

    def test_result_is_an_int_not_a_float(self):
        """`.timestamp()` would return a float and put a rounding artifact in
        the consensus path."""
        assert type(core.parse_block_time("2026-08-09T12:34:56Z")) is int

    @pytest.mark.parametrize("junk", ["", "   ", "not a time", None, [], {}, 3.5])
    def test_unparseable_raises(self, junk):
        """Raising is correct: every validator sees the same string and fails
        identically, whereas a fallback time would corrupt decay accounting on
        one node only."""
        with pytest.raises(ValueError):
            core.parse_block_time(junk)

    def test_bool_is_rejected(self):
        """`True == 1` in Python, so an unrejected bool would parse as epoch
        second 1 instead of failing."""
        with pytest.raises(ValueError):
            core.parse_block_time(True)


# --- policy ---------------------------------------------------------------


class TestPolicyValidation:
    def test_defaults_are_valid(self):
        core.Policy().validate()

    @pytest.mark.parametrize(
        "field,value",
        [
            ("half_life_seconds", 0),
            ("half_life_seconds", -1),
            ("prior_weight", -1),
            ("min_substantiated", 101),
            ("min_substantiated", -1),
            ("min_confidence", 101),
            ("confidence_tol", 101),
            ("repeat_shift_cap", -1),
            ("repeat_shift_cap", 64),
            ("min_bond", -1),
            ("slash_floor", 101),
            ("release_floor", 101),
            ("bond_lock_seconds", -1),
            ("collateral_ceiling_bp", -1),
            ("collateral_ceiling_bp", core.MAX_COLLATERAL_BP + 1),
            ("collateral_floor_bp", -1),
            ("collateral_forfeit_bp", -1),
            ("collateral_forfeit_bp", core.BP + 1),
        ],
    )
    def test_out_of_range_rejected(self, field, value):
        with pytest.raises(ValueError):
            core.Policy(**{field: value}).validate()

    def test_inverted_bond_bands_rejected(self):
        """Inverted, the two bands overlap and one grade is both slashable and
        releasable -- an ambiguity `bond_outcome` would have to break at
        random."""
        with pytest.raises(ValueError):
            core.Policy(slash_floor=80, release_floor=20).validate()

    def test_equal_bond_floors_allowed(self):
        """A hard cutoff with no middle band is a legitimate configuration."""
        core.Policy(slash_floor=50, release_floor=50).validate()

    def test_inverted_collateral_band_rejected(self):
        """Inverted, the collateral curve rises with reputation: the protocol
        would charge its best-reviewed agents the most to work, which is the
        mechanism running backwards rather than a tuning choice."""
        with pytest.raises(ValueError):
            core.Policy(collateral_floor_bp=9000, collateral_ceiling_bp=1000).validate()

    def test_flat_collateral_band_allowed(self):
        """One rate for everyone is a legitimate configuration -- it is the
        collateral layer with the reputation discount switched off, which is what
        a deployment that does not yet trust its own scores would run."""
        core.Policy(collateral_floor_bp=5000, collateral_ceiling_bp=5000).validate()

    def test_policy_is_frozen(self):
        with pytest.raises(Exception):
            POLICY.min_bond = 99  # type: ignore[misc]


# --- decay ----------------------------------------------------------------


class TestDecay:
    def test_zero_age_is_full_weight(self):
        assert core.decay_bp(BP, 0, HALF_LIFE) == BP

    def test_one_half_life_halves(self):
        assert core.decay_bp(BP, HALF_LIFE, HALF_LIFE) == BP // 2

    def test_two_half_lives_quarter(self):
        assert core.decay_bp(BP, 2 * HALF_LIFE, HALF_LIFE) == BP // 4

    def test_interpolates_inside_the_step(self):
        """Truncating to the lower halving would hold full weight for 90 days and
        then drop half of it in one second -- a cliff an agent could time a
        submission around."""
        half_step = core.decay_bp(BP, HALF_LIFE // 2, HALF_LIFE)
        assert BP // 2 < half_step < BP
        assert half_step == 7500

    def test_monotonic_non_increasing_in_age(self):
        step = HALF_LIFE // 37  # deliberately not a divisor of the half-life
        previous = BP + 1
        for age in range(0, HALF_LIFE * 5, step):
            current = core.decay_bp(BP, age, HALF_LIFE)
            assert current <= previous, f"weight rose at age {age}"
            previous = current

    def test_continuous_across_the_step_boundary(self):
        """The value just before a boundary must not sit below the value just
        after it, or the interpolation has introduced its own cliff."""
        before = core.decay_bp(BP, HALF_LIFE - 1, HALF_LIFE)
        at = core.decay_bp(BP, HALF_LIFE, HALF_LIFE)
        assert before >= at

    def test_negative_age_clamps_to_full_weight(self):
        """A stored timestamp newer than block time is clock skew, not evidence
        that an attestation is worth more than when it was written."""
        assert core.decay_bp(BP, -99999, HALF_LIFE) == BP

    def test_far_future_underflows_to_zero(self):
        assert core.decay_bp(BP, HALF_LIFE * 5000, HALF_LIFE) == 0

    def test_huge_age_does_not_shift_by_a_huge_amount(self):
        """The guard exists so a corrupt timestamp cannot turn into an enormous
        bit shift."""
        assert core.decay_bp(BP, 10**30, HALF_LIFE) == 0

    def test_zero_weight_stays_zero(self):
        assert core.decay_bp(0, 12345, HALF_LIFE) == 0

    def test_negative_weight_floors_at_zero(self):
        assert core.decay_bp(-500, 0, HALF_LIFE) == 0

    def test_invalid_half_life_raises(self):
        with pytest.raises(ValueError):
            core.decay_bp(BP, 10, 0)

    def test_result_is_always_an_int(self):
        for age in (0, 1, HALF_LIFE // 3, HALF_LIFE, HALF_LIFE * 7 + 11):
            assert type(core.decay_bp(BP, age, HALF_LIFE)) is int


# --- attestation weight ---------------------------------------------------


class TestAttestationWeight:
    def test_perfect_fresh_first_attestation_is_full_weight(self):
        assert weight() == BP

    def test_weight_is_proportional_to_substantiation(self):
        """Evidence quality *is* the weight. This is the whole design."""
        assert weight(substantiated=100) == BP
        assert weight(substantiated=50) == BP // 2

    def test_unsubstantiated_praise_carries_no_weight(self):
        """The anti-shill gate: a glowing review with nothing behind it is
        recorded for audit and ignored by the arithmetic."""
        assert weight(substantiated=0) == 0
        assert weight(substantiated=POLICY.min_substantiated - 1) == 0

    def test_at_the_substantiation_floor_weight_appears(self):
        assert weight(substantiated=POLICY.min_substantiated) > 0

    def test_low_confidence_carries_no_weight(self):
        assert weight(confidence=POLICY.min_confidence - 1) == 0

    def test_confidence_gates_but_does_not_scale(self):
        """Confidence is the model's certainty about its own reading, not a
        property of the attestation. Letting it scale would make the score track
        model hesitancy as much as evidence."""
        assert weight(confidence=100) == weight(confidence=POLICY.min_confidence)

    def test_repeat_attestations_halve(self):
        assert weight(repeat_index=1) == BP // 2
        assert weight(repeat_index=2) == BP // 4
        assert weight(repeat_index=9) == BP >> 8  # capped shift

    def test_repeat_damping_is_capped(self):
        """A prolific but honest counterparty must not silently underflow to
        nothing."""
        deep = weight(repeat_index=50)
        assert deep == BP >> POLICY.repeat_shift_cap
        assert deep > 0

    def test_weight_is_strictly_decreasing_in_repeat_index_up_to_the_cap(self):
        values = [weight(repeat_index=k) for k in range(POLICY.repeat_shift_cap + 1)]
        assert values == sorted(values, reverse=True)
        assert len(set(values)) == len(values)

    def test_age_decays_weight(self):
        assert weight(age_seconds=HALF_LIFE) == weight() // 2

    @pytest.mark.parametrize("junk", [None, "80", [], {}, 3.5, True, False])
    def test_non_int_grades_carry_no_weight(self, junk):
        """Total: a malformed grade weighs nothing rather than raising. Bools are
        rejected explicitly because `True == 1` would otherwise read as a real
        substantiation score of 1."""
        assert weight(substantiated=junk) == 0
        assert weight(confidence=junk) == 0

    def test_out_of_range_substantiation_is_clamped(self):
        assert weight(substantiated=10**9) == BP

    def test_invalid_policy_raises(self):
        with pytest.raises(ValueError):
            weight(policy=core.Policy(half_life_seconds=0))


# --- aggregation ----------------------------------------------------------


class TestAggregate:
    def test_no_history_is_exactly_neutral(self):
        """Unknown must be distinct from bad. A new agent cannot be
        indistinguishable from one that was graded badly."""
        score, total = core.aggregate([], POLICY)
        assert score == core.NEUTRAL_BP
        assert total == 0

    def test_one_perfect_review_does_not_produce_a_perfect_agent(self):
        """Shrinkage is what a sybil cannot cheaply buy: reputation has to be
        accumulated, not minted in one transaction."""
        score, _ = core.aggregate([(BP, BP)], POLICY)
        assert score == 6250
        assert score < BP

    def test_score_climbs_with_corroborating_history(self):
        scores = [
            core.aggregate([(BP, BP)] * n, POLICY)[0] for n in (1, 2, 4, 8, 16)
        ]
        assert scores == sorted(scores)
        assert scores[-1] > 9000

    def test_zero_weight_entries_are_ignored_entirely(self):
        with_junk = core.aggregate([(BP, BP), (0, 0), (-5, 0)], POLICY)
        alone = core.aggregate([(BP, BP)], POLICY)
        assert with_junk == alone

    def test_bad_reviews_pull_the_score_down(self):
        good, _ = core.aggregate([(BP, BP)], POLICY)
        bad, _ = core.aggregate([(BP, 0)], POLICY)
        assert bad < core.NEUTRAL_BP < good

    def test_grades_are_clamped_into_range(self):
        clamped, _ = core.aggregate([(BP, 10**9)], POLICY)
        legit, _ = core.aggregate([(BP, BP)], POLICY)
        assert clamped == legit

    def test_total_weight_is_reported(self):
        _, total = core.aggregate([(BP, BP), (BP // 2, BP)], POLICY)
        assert total == BP + BP // 2

    def test_zero_prior_gives_the_plain_weighted_mean(self):
        score, _ = core.aggregate([(BP, 8000), (BP, 4000)], core.Policy(prior_weight=0))
        assert score == 6000

    def test_score_is_always_an_int(self):
        score, total = core.aggregate([(BP, 3333), (777, 1111)], POLICY)
        assert type(score) is int
        assert type(total) is int


class TestSybilResistance:
    """The property the whole design exists to produce, asserted directly."""

    def test_one_attester_scores_below_many_distinct_attesters(self):
        """Ten reviews from one address must be worth strictly less than ten
        from ten addresses, with everything else held identical."""
        n = 10
        farm = [
            (weight(repeat_index=k), BP) for k in range(n)
        ]
        honest = [(weight(repeat_index=0), BP) for _ in range(n)]

        farm_score, _ = core.aggregate(farm, POLICY)
        honest_score, _ = core.aggregate(honest, POLICY)
        assert farm_score < honest_score

    @pytest.mark.parametrize("n", [2, 3, 5, 8, 13, 21])
    def test_holds_at_every_scale(self, n):
        farm = [(weight(repeat_index=k), BP) for k in range(n)]
        honest = [(weight(repeat_index=0), BP) for _ in range(n)]
        assert core.aggregate(farm, POLICY)[0] < core.aggregate(honest, POLICY)[0]

    def test_a_farm_of_unsubstantiated_praise_moves_nothing(self):
        """Combining both defenses: sock puppets that submit no real evidence
        cannot move the score at all, however many of them there are."""
        farm = [
            (weight(substantiated=0, repeat_index=k), BP) for k in range(50)
        ]
        score, total = core.aggregate(farm, POLICY)
        assert total == 0
        assert score == core.NEUTRAL_BP

    def test_bond_cost_and_attestation_weight_move_in_opposite_directions(self):
        """The economic argument in one assertion. Bond doubles per repeat while
        weight halves, so the cost per unit of score moved rises as the square --
        a farm pays geometrically more for attestations worth geometrically
        less."""
        policy = core.Policy(min_bond=1000)
        bonds = [core.bond_required(k, policy) for k in range(policy.repeat_shift_cap + 1)]
        weights = [weight(repeat_index=k, policy=policy) for k in range(policy.repeat_shift_cap + 1)]

        assert bonds == sorted(bonds)
        assert len(set(bonds)) == len(bonds)  # strictly increasing
        assert weights == sorted(weights, reverse=True)
        assert len(set(weights)) == len(weights)  # strictly decreasing

        cost_per_weight = [b * BP // w for b, w in zip(bonds, weights)]
        assert cost_per_weight == sorted(cost_per_weight)
        # Quadratic, not linear: four doublings of the index quadruple-square the
        # cost of moving the score by the same amount.
        assert cost_per_weight[4] == cost_per_weight[0] * 256


# --- bonding --------------------------------------------------------------


class TestBondRequired:
    def test_disabled_when_min_bond_is_zero(self):
        assert core.bond_required(0, POLICY) == 0
        assert core.bond_required(7, POLICY) == 0

    def test_first_attestation_costs_the_base(self):
        assert core.bond_required(0, core.Policy(min_bond=1000)) == 1000

    def test_doubles_per_repeat(self):
        policy = core.Policy(min_bond=1000)
        assert core.bond_required(1, policy) == 2000
        assert core.bond_required(2, policy) == 4000
        assert core.bond_required(3, policy) == 8000

    def test_capped_so_an_honest_counterparty_is_not_priced_out(self):
        policy = core.Policy(min_bond=1000)
        capped = core.bond_required(999, policy)
        assert capped == 1000 << policy.repeat_shift_cap
        assert capped == core.bond_required(policy.repeat_shift_cap, policy)

    def test_negative_index_is_treated_as_the_first(self):
        assert core.bond_required(-3, core.Policy(min_bond=1000)) == 1000


class TestBondOutcome:
    def test_well_substantiated_is_releasable(self):
        g = core.canonicalize_grade(grade(substantiated=100), POLICY)
        assert core.bond_outcome(g, POLICY) == core.BOND_RELEASABLE

    def test_unsubstantiated_is_slashed(self):
        g = core.canonicalize_grade(grade(substantiated=0), POLICY)
        assert core.bond_outcome(g, POLICY) == core.BOND_SLASHED

    def test_the_middle_band_is_releasable(self):
        """Between the floors the attestation already carries near-zero weight,
        so charging for it too would punish an honest attester twice."""
        middle = (POLICY.slash_floor + POLICY.release_floor) // 2
        assert POLICY.slash_floor <= middle < POLICY.release_floor
        g = core.canonicalize_grade(grade(substantiated=middle), POLICY)
        assert core.bond_outcome(g, POLICY) == core.BOND_RELEASABLE

    def test_boundary_is_inclusive_at_the_slash_floor(self):
        at = core.canonicalize_grade(grade(substantiated=POLICY.slash_floor), POLICY)
        below = core.canonicalize_grade(grade(substantiated=POLICY.slash_floor - 1), POLICY)
        assert core.bond_outcome(at, POLICY) == core.BOND_RELEASABLE
        assert core.bond_outcome(below, POLICY) == core.BOND_SLASHED

    @pytest.mark.parametrize("fulfilled", [0, 1, 25, 50, 99, 100])
    def test_honest_criticism_is_never_slashed(self, fulfilled):
        """The property that keeps this from becoming a praise machine. A
        scathing review is safe as long as it is evidenced; the bond is at risk
        for asserting without support, never for saying something negative.

        `bond_outcome` reads `substantiated` and never `fulfilled` -- that is the
        point, and this test pins it across the whole range of the latter.
        """
        scathing_but_evidenced = core.canonicalize_grade(
            grade(verdict=core.VERDICT_UNFULFILLED, fulfilled=fulfilled, substantiated=95),
            POLICY,
        )
        assert core.bond_outcome(scathing_but_evidenced, POLICY) == core.BOND_RELEASABLE

    def test_glowing_but_unevidenced_is_slashed(self):
        glowing_but_empty = core.canonicalize_grade(
            grade(verdict=core.VERDICT_FULFILLED, fulfilled=100, substantiated=0),
            POLICY,
        )
        assert core.bond_outcome(glowing_but_empty, POLICY) == core.BOND_SLASHED

    @pytest.mark.parametrize("junk", [None, "95", [], {}, 3.5, True, False, {"substantiated": "80"}])
    def test_malformed_grades_are_released_not_slashed(self, junk):
        """Fails toward release, deliberately. Any input that is not a readable
        grade is a failure to establish that the attester asserted without
        support, and an unproven case does not justify taking their money."""
        assert core.bond_outcome(junk, POLICY) == core.BOND_RELEASABLE

    def test_ungraded_response_releases(self):
        """A response this contract could not read is evidence about this
        contract's own model, not about the attester. Nothing is lost by being
        lenient: an attester who deliberately induced an unreadable grade gets
        their bond back alongside an attestation of exactly zero weight, which is
        what they already had by not attesting at all."""
        assert core.bond_outcome(dict(core.UNGRADED), POLICY) == core.BOND_RELEASABLE


# --- work collateral ------------------------------------------------------
#
# The mechanism the score is for. `bond_required` above prices *attesting*;
# everything here prices *working*, off the agent's own standing, and it is the
# only path in the protocol where `score_bp` decides an amount of money.


class TestCollateralRate:
    def test_no_history_pays_the_ceiling(self):
        assert core.collateral_rate_bp(0, POLICY) == POLICY.collateral_ceiling_bp

    def test_a_perfect_record_pays_the_floor(self):
        assert core.collateral_rate_bp(BP, POLICY) == POLICY.collateral_floor_bp

    def test_an_unknown_agent_sits_between_them(self):
        """The neutral score is the midpoint, so an agent with no attestations
        posts the midpoint rate -- 87.5% of the stake at the defaults."""
        assert core.collateral_rate_bp(core.NEUTRAL_BP, POLICY) == 8750

    def test_never_rises_with_reputation(self):
        rates = [core.collateral_rate_bp(score, POLICY) for score in range(0, BP + 1, 250)]
        assert rates == sorted(rates, reverse=True)

    def test_a_better_score_is_strictly_cheaper(self):
        """Not merely non-increasing: the discount has to be visible at the
        resolution a real score moves at, or reputation buys nothing."""
        assert core.collateral_rate_bp(8000, POLICY) < core.collateral_rate_bp(5000, POLICY)
        assert core.collateral_rate_bp(5000, POLICY) < core.collateral_rate_bp(2000, POLICY)

    @pytest.mark.parametrize("score", [-1, -100000, BP + 1, 10 * BP])
    def test_scores_outside_the_range_are_clamped(self, score):
        """`aggregate` cannot return one, but this is also called with a score a
        caller supplied, and an out-of-range one must not price collateral
        outside the policy's own band."""
        rate = core.collateral_rate_bp(score, POLICY)
        assert POLICY.collateral_floor_bp <= rate <= POLICY.collateral_ceiling_bp

    @pytest.mark.parametrize("junk", [None, "5000", 5000.0, True, [], {}])
    def test_unreadable_standing_is_priced_as_no_standing(self, junk):
        assert core.collateral_rate_bp(junk, POLICY) == POLICY.collateral_ceiling_bp

    def test_a_flat_band_charges_everyone_the_same(self):
        flat = core.Policy(collateral_floor_bp=5000, collateral_ceiling_bp=5000)
        assert {core.collateral_rate_bp(score, flat) for score in (0, 4000, BP)} == {5000}


class TestCollateralRequired:
    def test_no_stake_means_no_collateral(self):
        """An engagement that declares no value is the lifecycle as it was before
        it had a collateral layer, exactly as `min_bond = 0` switches the bond
        off."""
        assert core.collateral_required(0, 0, POLICY) == 0
        assert core.collateral_required(BP, 0, POLICY) == 0

    def test_an_unknown_agent_posts_most_of_the_stake(self):
        assert core.collateral_required(core.NEUTRAL_BP, 1000, POLICY) == 875

    def test_reputation_frees_working_capital(self):
        """The claim the protocol makes, in one assertion: the same job costs a
        well-reviewed agent a fraction of what it costs an unknown one."""
        stake = 100 * 10**18
        unknown = core.collateral_required(core.NEUTRAL_BP, stake, POLICY)
        strong = core.collateral_required(8500, stake, POLICY)
        assert strong < unknown
        assert unknown - strong == 4375 * 10**16  # 43.75 GEN freed per 100 staked

    def test_the_discount_is_capped_by_the_floor(self):
        """No record, however good, works for free. The floor is what stops a
        bought reputation from converting into unlimited leverage."""
        stake = 10**18
        assert core.collateral_required(BP, stake, POLICY) == stake * POLICY.collateral_floor_bp // BP
        assert core.collateral_required(BP, stake, POLICY) > 0

    def test_rounds_down(self):
        """Down, so a caller who sends exactly what they were quoted is never
        rejected for a unit of rounding."""
        assert core.collateral_required(BP, 3, POLICY) == 0  # 3 * 2500 // 10000
        assert core.collateral_required(0, 3, POLICY) == 4  # 3 * 15000 // 10000

    @pytest.mark.parametrize("stake", [-1, -10**18, None, "1000", 1000.0, True])
    def test_unusable_stakes_price_at_zero(self, stake):
        assert core.collateral_required(core.NEUTRAL_BP, stake, POLICY) == 0

    def test_result_is_a_plain_int(self):
        value = core.collateral_required(core.NEUTRAL_BP, 10**18, POLICY)
        assert type(value) is int


class TestMaxStake:
    def test_a_rate_at_or_below_par_admits_any_stake(self):
        """Below `BP` the collateral is smaller than the stake, so anything that
        fits in storage fits after the multiplication."""
        cheap = core.Policy(collateral_ceiling_bp=BP, collateral_floor_bp=0)
        assert core.max_stake(cheap) == core.U256_MAX

    def test_the_largest_admissible_stake_still_fits_in_storage(self):
        largest = core.max_stake(POLICY)
        assert core.collateral_required(0, largest, POLICY) <= core.U256_MAX

    def test_one_more_would_not(self):
        """The bound is tight, which is what makes rejecting at open time
        equivalent to never faulting at accept time."""
        largest = core.max_stake(POLICY)
        assert core.collateral_required(0, largest + 1, POLICY) > core.U256_MAX


class TestCollateralOutcome:
    def test_delivered_work_is_released(self):
        g = core.canonicalize_grade(grade(fulfilled=90, substantiated=80), POLICY)
        assert core.collateral_outcome(g, POLICY) == core.COLLATERAL_RELEASABLE

    def test_evidenced_failure_forfeits(self):
        g = core.canonicalize_grade(
            grade(verdict=core.VERDICT_UNFULFILLED, fulfilled=5, substantiated=90, confidence=90),
            POLICY,
        )
        assert core.collateral_outcome(g, POLICY) == core.COLLATERAL_FORFEIT

    def test_an_unevidenced_accusation_takes_nothing(self):
        """The attack this gate exists to close. Without it the cheapest way to
        take an agent's collateral is to assert that they failed and post no
        evidence -- an attestation worth exactly zero to the score."""
        accusation = core.canonicalize_grade(
            grade(verdict=core.VERDICT_UNFULFILLED, fulfilled=0, substantiated=0, confidence=90),
            POLICY,
        )
        assert core.collateral_outcome(accusation, POLICY) == core.COLLATERAL_RELEASABLE

    def test_a_hesitant_reading_takes_nothing(self):
        unsure = core.canonicalize_grade(
            grade(verdict=core.VERDICT_UNFULFILLED, fulfilled=0, substantiated=90, confidence=10),
            POLICY,
        )
        assert core.collateral_outcome(unsure, POLICY) == core.COLLATERAL_RELEASABLE

    def test_ungraded_takes_nothing(self):
        """A response this contract could not read is evidence about the model,
        not about the provider."""
        assert core.collateral_outcome(dict(core.UNGRADED), POLICY) == core.COLLATERAL_RELEASABLE

    @pytest.mark.parametrize("junk", [None, "forfeit", 42, [], {"verdict": "unfulfilled"}])
    def test_total_and_lenient_on_junk(self, junk):
        assert core.collateral_outcome(junk, POLICY) == core.COLLATERAL_RELEASABLE

    def test_the_forfeit_boundary_is_exclusive(self):
        at = core.canonicalize_grade(
            grade(fulfilled=25, substantiated=90, confidence=90), POLICY
        )
        below = core.canonicalize_grade(
            grade(fulfilled=24, substantiated=90, confidence=90), POLICY
        )
        assert at["fulfilled"] == POLICY.collateral_forfeit_bp
        assert core.collateral_outcome(at, POLICY) == core.COLLATERAL_RELEASABLE
        assert core.collateral_outcome(below, POLICY) == core.COLLATERAL_FORFEIT

    @pytest.mark.parametrize("substantiated", [0, 10, 24, 25, 49])
    def test_nothing_that_carries_no_weight_can_forfeit(self, substantiated):
        """The invariant tying the two halves of the protocol together: an
        attestation that cannot move the score cannot move the money either.

        Below the release floor the grade is either weightless outright or
        already damped hard, and taking a provider's collateral on it would let
        an attacker buy a forfeit for the price of one bond.
        """
        weak = core.canonicalize_grade(
            grade(
                verdict=core.VERDICT_UNFULFILLED,
                fulfilled=0,
                substantiated=substantiated,
                confidence=100,
            ),
            POLICY,
        )
        assert core.collateral_outcome(weak, POLICY) == core.COLLATERAL_RELEASABLE

    def test_forfeiting_and_slashing_are_independent(self):
        """The two economic outcomes answer different questions about the same
        attestation, so one grade can trigger either, both, or neither.

        A well-evidenced report of undelivered work forfeits the provider's
        collateral and returns the attester's bond -- the attester did their job
        precisely by writing it.
        """
        g = core.canonicalize_grade(
            grade(verdict=core.VERDICT_UNFULFILLED, fulfilled=0, substantiated=95, confidence=95),
            POLICY,
        )
        assert core.collateral_outcome(g, POLICY) == core.COLLATERAL_FORFEIT
        assert core.bond_outcome(g, POLICY) == core.BOND_RELEASABLE


class TestReputationIsCollateral:
    def test_the_score_is_the_only_input_that_moves_the_price(self):
        """Two agents, one stake, one policy: the difference in what they have to
        find before they can work is their reputation, expressed in money."""
        stake = 10**18
        priced = {
            score: core.collateral_required(score, stake, POLICY)
            for score in (0, 2500, core.NEUTRAL_BP, 7500, BP)
        }
        assert list(priced.values()) == sorted(priced.values(), reverse=True)
        assert priced[0] > stake  # no record: more than the work is worth
        assert priced[BP] < stake // 3  # a full record: a fraction of it

    def test_a_bought_score_pays_the_rising_curve_for_a_bounded_discount(self):
        """Why the floor exists. The bond an attacker pays to manufacture a score
        doubles per repeat, while the most that score can ever save them is the
        distance between the ceiling and the floor -- a bounded prize against an
        unbounded price.
        """
        policy = core.Policy(min_bond=10**18)
        stake = 10**18
        best_case_saving = core.collateral_required(0, stake, policy) - core.collateral_required(
            BP, stake, policy
        )
        cost_of_four_fake_attestations = sum(core.bond_required(k, policy) for k in range(4))
        assert best_case_saving == stake * 12500 // BP
        assert cost_of_four_fake_attestations > best_case_saving


# --- verdict coercion -----------------------------------------------------


class TestCanonicalizeGrade:
    def test_well_formed_dict_survives(self):
        result = core.canonicalize_grade(grade(), POLICY)
        assert result["verdict"] == core.VERDICT_FULFILLED
        assert result["fulfilled"] == 9000  # widened to basis points
        assert result["substantiated"] == 80
        assert result["confidence"] == 85

    def test_json_string_is_accepted(self):
        assert core.canonicalize_grade(json.dumps(grade()), POLICY) == (
            core.canonicalize_grade(grade(), POLICY)
        )

    def test_verdict_is_case_and_whitespace_insensitive(self):
        result = core.canonicalize_grade(grade(verdict="  PARTIAL  "), POLICY)
        assert result["verdict"] == core.VERDICT_PARTIAL

    def test_unknown_verdict_collapses_to_ungraded(self):
        assert core.canonicalize_grade(grade(verdict="excellent"), POLICY) == core.UNGRADED

    def test_scores_are_clamped_not_rejected(self):
        result = core.canonicalize_grade(
            grade(fulfilled=10**9, substantiated=-50, confidence=10**9), POLICY
        )
        assert result["fulfilled"] == BP
        assert result["substantiated"] == 0
        assert result["confidence"] == 100

    @pytest.mark.parametrize("field", ["fulfilled", "substantiated", "confidence"])
    def test_bools_are_rejected(self, field):
        """`True == 1` in Python. Accepted, a sloppy `true` would read as a real
        score of 1 rather than as a malformed response."""
        assert core.canonicalize_grade(grade(**{field: True}), POLICY) == core.UNGRADED

    @pytest.mark.parametrize("field", ["fulfilled", "substantiated", "confidence"])
    def test_missing_numeric_fields_collapse(self, field):
        payload = grade()
        del payload[field]
        assert core.canonicalize_grade(payload, POLICY) == core.UNGRADED

    def test_extra_fields_are_dropped(self):
        """A model that volunteers extra keys must not widen the stored shape,
        or two nodes could encode different bytes for the same grade."""
        result = core.canonicalize_grade(grade(rationale="looks fine", score=7), POLICY)
        assert set(result) == {"verdict", "fulfilled", "substantiated", "confidence"}

    def test_failure_is_neutral_and_weightless_not_bad(self):
        """Fail-closed for a reputation system means the score does not move. A
        model returning garbage is evidence about the model, not about the agent
        being graded, so it must not push the agent down either."""
        assert core.UNGRADED["fulfilled"] == core.NEUTRAL_BP
        assert core.UNGRADED["substantiated"] == 0
        assert weight(substantiated=core.UNGRADED["substantiated"]) == 0

    @pytest.mark.parametrize(
        "junk",
        [
            "",
            "   ",
            "not json",
            "null",
            "[]",
            "[1, 2, 3]",
            '"a string"',
            "123",
            "{",
            '{"verdict": null}',
            '{"verdict": 7}',
            '{"verdict": ["fulfilled"]}',
            '{"verdict": "fulfilled"}',
            '{"verdict": "ungraded", "fulfilled": 50, "substantiated": 90, "confidence": 90}',
            "{}",
            None,
            42,
            3.5,
            [],
            (),
            b"bytes",
            True,
            {"verdict": {"nested": "dict"}},
            {"verdict": "fulfilled", "fulfilled": "90", "substantiated": 80, "confidence": 85},
            {"verdict": "fulfilled", "fulfilled": None, "substantiated": 80, "confidence": 85},
            {"verdict": "fulfilled", "fulfilled": 90.5, "substantiated": 80, "confidence": 85},
        ],
    )
    def test_is_total_across_a_fuzz_corpus(self, junk):
        """No input raises, and every unusable one lands on the same canonical
        value -- so two nodes that both refuse a response, for different reasons,
        still produce byte-identical grades."""
        result = core.canonicalize_grade(junk, POLICY)
        assert result == core.UNGRADED

    def test_returns_a_copy_so_the_canonical_value_cannot_be_mutated(self):
        first = core.canonicalize_grade("garbage", POLICY)
        first["substantiated"] = 100
        assert core.UNGRADED["substantiated"] == 0
        assert core.canonicalize_grade("garbage", POLICY)["substantiated"] == 0


class TestEncodeGrade:
    def test_key_order_does_not_change_the_bytes(self):
        a = core.canonicalize_grade(grade(), POLICY)
        b = dict(reversed(list(a.items())))
        assert core.encode_grade(a) == core.encode_grade(b)

    def test_encoding_is_ascii_and_compact(self):
        encoded = core.encode_grade(core.canonicalize_grade(grade(), POLICY))
        assert encoded.isascii()
        assert " " not in encoded

    def test_round_trips_through_decode(self):
        original = core.canonicalize_grade(grade(), POLICY)
        assert core.decode_grade(core.encode_grade(original), POLICY) == original

    def test_decode_is_idempotent(self):
        """The property that matters on the calldata path. `fulfilled` crosses the
        wire in basis points, so the decoder must not rescale it -- widening twice
        turns any grade above 100bp into a flawless 10000."""
        once = core.decode_grade(core.encode_grade(core.canonicalize_grade(grade(), POLICY)), POLICY)
        assert core.decode_grade(core.encode_grade(once), POLICY) == once

    def test_decoding_does_not_rescale_fulfilled(self):
        original = core.canonicalize_grade(grade(fulfilled=40), POLICY)
        assert original["fulfilled"] == 4000
        assert core.decode_grade(core.encode_grade(original), POLICY)["fulfilled"] == 4000

    @pytest.mark.parametrize("junk", [None, "not json", "[]", "3", [], 7, {"verdict": "nope"}])
    def test_malformed_encodings_decode_to_ungraded(self, junk):
        assert core.decode_grade(junk, POLICY) == core.UNGRADED


class TestGradesAgree:
    def test_identical_grades_agree(self):
        g = core.canonicalize_grade(grade(), POLICY)
        assert core.grades_agree(g, g, POLICY)

    def test_small_spread_is_tolerated(self):
        """Two different models reading the same evidence will not land on the
        same integer. Demanding they do would fail every round."""
        mine = core.canonicalize_grade(grade(fulfilled=90, substantiated=80), POLICY)
        theirs = core.canonicalize_grade(grade(fulfilled=80, substantiated=70), POLICY)
        assert core.grades_agree(mine, theirs, POLICY)

    def test_large_spread_disagrees(self):
        mine = core.canonicalize_grade(grade(fulfilled=90), POLICY)
        theirs = core.canonicalize_grade(grade(fulfilled=40), POLICY)
        assert not core.grades_agree(mine, theirs, POLICY)

    def test_tolerance_is_scaled_consistently_across_units(self):
        """`fulfilled` is stored in basis points and the other two on 0-100, so a
        tolerance applied without widening would be a hundred times too tight on
        one field."""
        tol = POLICY.confidence_tol
        at_edge = core.canonicalize_grade(grade(fulfilled=90 - tol), POLICY)
        past_edge = core.canonicalize_grade(grade(fulfilled=90 - tol - 1), POLICY)
        mine = core.canonicalize_grade(grade(fulfilled=90), POLICY)
        assert core.grades_agree(mine, at_edge, POLICY)
        assert not core.grades_agree(mine, past_edge, POLICY)

    def test_different_verdicts_never_agree(self):
        mine = core.canonicalize_grade(grade(verdict=core.VERDICT_FULFILLED), POLICY)
        theirs = core.canonicalize_grade(grade(verdict=core.VERDICT_PARTIAL), POLICY)
        assert not core.grades_agree(mine, theirs, POLICY)

    def test_two_ungraded_results_agree(self):
        """Both nodes found the response unusable, which is a real agreement
        about a real outcome. Rotating here would just re-ask a model that is
        reliably returning junk to everyone."""
        assert core.grades_agree(dict(core.UNGRADED), dict(core.UNGRADED), POLICY)

    def test_ungraded_never_agrees_with_a_real_grade(self):
        real = core.canonicalize_grade(grade(), POLICY)
        assert not core.grades_agree(real, dict(core.UNGRADED), POLICY)
        assert not core.grades_agree(dict(core.UNGRADED), real, POLICY)

    @pytest.mark.parametrize(
        "theirs",
        [
            None,
            "a string",
            42,
            [],
            {},
            {"verdict": "fulfilled"},
            {"verdict": "fulfilled", "fulfilled": "9000", "substantiated": 80, "confidence": 85},
            {"verdict": "fulfilled", "fulfilled": None, "substantiated": 80, "confidence": 85},
            {"verdict": "fulfilled", "fulfilled": True, "substantiated": 80, "confidence": 85},
            {"verdict": None, "fulfilled": 9000, "substantiated": 80, "confidence": 85},
        ],
    )
    def test_is_total_against_untrusted_leader_output(self, theirs):
        """`theirs` is the leader's calldata, which is untrusted input. A
        `TypeError` raised inside the validator would be an unclassified fault no
        node could compare -- so a malformed grade must resolve to False, not
        escape."""
        mine = core.canonicalize_grade(grade(), POLICY)
        assert core.grades_agree(mine, theirs, POLICY) is False

    def test_is_total_when_both_sides_are_junk(self):
        assert core.grades_agree("junk", "junk", POLICY) is False


# --- content addressing ---------------------------------------------------


class TestScopeDigest:
    def test_is_deterministic(self):
        assert core.scope_digest("deliver 40 qualified leads") == core.scope_digest(
            "deliver 40 qualified leads"
        )

    def test_differs_on_any_change(self):
        """This is what stops a disappointed client retrofitting the standard
        they are grading against."""
        assert core.scope_digest("deliver 40 leads") != core.scope_digest(
            "deliver 400 leads"
        )

    def test_is_hex_and_fixed_width(self):
        digest = core.scope_digest("anything")
        assert len(digest) == 64
        assert digest.isascii()

    def test_handles_unicode_scope_text(self):
        assert len(core.scope_digest("livrer 40 prospects qualifiés")) == 64


class TestAttestationSalt:
    def test_is_deterministic_across_calls(self):
        """Every validator must build a byte-identical prompt, so the salt is
        derived from content rather than drawn at random."""
        args = dict(scope="s", attester="0xA", subject="0xB", claim="c")
        assert core.attestation_salt(**args) == core.attestation_salt(**args)

    def test_address_case_does_not_change_it(self):
        lower = core.attestation_salt(scope="s", attester="0xab", subject="0xcd", claim="c")
        upper = core.attestation_salt(scope="s", attester="0xAB", subject="0xCD", claim="c")
        assert lower == upper

    @pytest.mark.parametrize("field", ["scope", "attester", "subject", "claim"])
    def test_every_input_affects_it(self, field):
        base = dict(scope="s", attester="0xA", subject="0xB", claim="c")
        changed = {**base, field: base[field] + "!"}
        assert core.attestation_salt(**base) != core.attestation_salt(**changed)

    def test_parties_cannot_be_swapped_without_changing_it(self):
        """Attester and subject are distinct roles; a salt that ignored the order
        would let one attestation's prompt fence be reused for its mirror."""
        forward = core.attestation_salt(scope="s", attester="0xA", subject="0xB", claim="c")
        reverse = core.attestation_salt(scope="s", attester="0xB", subject="0xA", claim="c")
        assert forward != reverse


# --- module-level invariants ----------------------------------------------


class TestNoFloatsAnywhere:
    """A float in the deterministic path lets two validators disagree in the last
    bit and turns a rounding artifact into a consensus failure."""

    def test_every_numeric_output_is_an_int(self):
        assert type(core.decay_bp(BP, 1234, HALF_LIFE)) is int
        assert type(weight(age_seconds=1234)) is int
        assert type(core.bond_required(3, core.Policy(min_bond=7))) is int
        score, total = core.aggregate([(BP, 3333)], POLICY)
        assert type(score) is int and type(total) is int
        canonical = core.canonicalize_grade(grade(), POLICY)
        for field in ("fulfilled", "substantiated", "confidence"):
            assert type(canonical[field]) is int

    def test_source_contains_no_float_literals_or_true_division(self):
        import pathlib
        import ast

        source = (pathlib.Path(core.__file__)).read_text(encoding="utf-8")
        tree = ast.parse(source)
        floats = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, float)
        ]
        assert not floats, f"float literals at lines {[n.lineno for n in floats]}"
        divisions = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)
        ]
        assert not divisions, f"true division at lines {[n.lineno for n in divisions]}"


class TestReasonCodes:
    def test_every_declared_reason_is_in_the_set(self):
        """The codes are branched on by consumers and written into stored
        history, so they are a stable surface rather than free-form prose."""
        declared = {
            value
            for name, value in vars(core).items()
            if name.startswith("REASON_") and isinstance(value, str)
        }
        assert declared == set(core.REASONS)

    def test_reason_codes_are_unique(self):
        declared = [
            value
            for name, value in vars(core).items()
            if name.startswith("REASON_") and isinstance(value, str)
        ]
        assert len(declared) == len(set(declared))


class TestAgreementPreservesTheMoneyOutcome:
    """Two grades within tolerance must settle the money the same way.

    `grades_agree` allows the three numbers to differ, and has to: two models
    reading the same evidence do not land on the same integer, and demanding it
    would fail every consensus round. But both payouts are *threshold* functions
    of those numbers, and the default tolerance is wide enough to straddle
    either threshold.

    That was the defect. Validators could agree while disagreeing about who ends
    up with the money -- which is the one thing agreement is supposed to settle.
    """

    @staticmethod
    def _grade(**over):
        base = {
            "verdict": core.VERDICT_PARTIAL,
            "fulfilled": 5000,
            "substantiated": 60,
            "confidence": 80,
        }
        base.update(over)
        return base

    def test_bond_threshold_cannot_be_straddled(self):
        """`substantiated` 10 vs 30: one slashes the attester's bond, one does not."""
        mine = self._grade(substantiated=10)
        theirs = self._grade(substantiated=30)

        # Within tolerance by the numbers: the floor is 20 on a 0-100 scale and
        # so is the tolerance, so the pair is exactly the hard case.
        assert abs(10 - 30) <= POLICY.confidence_tol
        assert core.bond_outcome(mine, POLICY) == core.BOND_SLASHED
        assert core.bond_outcome(theirs, POLICY) == core.BOND_RELEASABLE

        assert not core.grades_agree(mine, theirs, POLICY)
        assert not core.grades_agree(theirs, mine, POLICY)

    def test_collateral_threshold_cannot_be_straddled(self):
        """`fulfilled` 1500 vs 3500: the provider's collateral changes hands."""
        mine = self._grade(fulfilled=1500)
        theirs = self._grade(fulfilled=3500)

        # 2000bp apart, which is exactly the tolerance once widened to the basis
        # point scale, and it crosses the 2500bp forfeit line.
        assert abs(1500 - 3500) <= (POLICY.confidence_tol * core.BP) // 100
        assert core.collateral_outcome(mine, POLICY) == core.COLLATERAL_FORFEIT
        assert core.collateral_outcome(theirs, POLICY) == core.COLLATERAL_RELEASABLE

        assert not core.grades_agree(mine, theirs, POLICY)
        assert not core.grades_agree(theirs, mine, POLICY)

    def test_tolerance_still_works_on_the_same_side_of_a_line(self):
        """The fix must not make every round fail: only threshold crossings do.

        Both of these are comfortably inside the same outcome, and differ by the
        full tolerance, so they still agree. Without this the change would be a
        denial of service dressed up as a correctness fix.
        """
        mine = self._grade(fulfilled=7000, substantiated=60, confidence=70)
        theirs = self._grade(fulfilled=8999, substantiated=80, confidence=90)

        assert core.bond_outcome(mine, POLICY) == core.bond_outcome(theirs, POLICY)
        assert core.collateral_outcome(mine, POLICY) == core.collateral_outcome(theirs, POLICY)
        assert core.grades_agree(mine, theirs, POLICY)

    def test_agreement_is_symmetric_across_every_threshold_pair(self):
        """Swept rather than spot-checked, because a one-sided rule is a bug.

        Any pair whose outcomes differ must disagree in both directions; any pair
        within tolerance on the same side must agree in both.
        """
        for a in range(0, 10001, 250):
            for b in (a, a + (POLICY.confidence_tol * core.BP) // 100):
                if b > 10000:
                    continue
                mine, theirs = self._grade(fulfilled=a), self._grade(fulfilled=b)
                forward = core.grades_agree(mine, theirs, POLICY)
                assert forward == core.grades_agree(theirs, mine, POLICY)
                if core.collateral_outcome(mine, POLICY) != core.collateral_outcome(theirs, POLICY):
                    assert not forward, f"fulfilled {a} vs {b} agreed across the forfeit line"

    def test_ungraded_pairs_are_unaffected(self):
        """Two unreadable responses still agree; both outcomes are lenient there."""
        mine = {"verdict": core.VERDICT_UNGRADED}
        theirs = {"verdict": core.VERDICT_UNGRADED}
        assert core.grades_agree(mine, theirs, POLICY)


class TestResolveWithdrawal:
    """The recovery mechanism, executed rather than inspected.

    `withdraw` moves an entitlement out of `owed` and into `in_flight` before it
    emits, so a transfer that never arrives leaves a claim that is still on the
    books and still readable. `resolve_withdrawal` is what decides whether to
    give it back. These are the cases it has to get right.
    """

    SETTLE = core.WITHDRAWAL_SETTLE_SECONDS

    def test_nothing_is_decided_before_the_transfer_can_have_settled(self):
        """The one way a recovery path can pay twice is by deciding too early."""
        assert (
            core.resolve_withdrawal(elapsed_seconds=0, held=1000, committed=1000)
            == core.WITHDRAWAL_UNSETTLED
        )
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE - 1, held=1000, committed=1000
            )
            == core.WITHDRAWAL_UNSETTLED
        )

    def test_the_window_opens_exactly_on_the_boundary(self):
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=1000, committed=1000
            )
            == core.WITHDRAWAL_RESTORED
        )

    def test_money_still_here_means_the_transfer_failed(self):
        """The contract covers every obligation with the claim on its books."""
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=1000, committed=1000
            )
            == core.WITHDRAWAL_RESTORED
        )
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=1001, committed=1000
            )
            == core.WITHDRAWAL_RESTORED
        )

    def test_money_gone_means_the_transfer_landed(self):
        """One wei short is enough: the value is not here, so it left."""
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=999, committed=1000
            )
            == core.WITHDRAWAL_DELIVERED
        )

    def test_a_delivered_payout_is_not_restored(self):
        """The realistic delivered case, with the numbers laid out.

        A contract holding 100 for one entitlement of 100 pays it out. Its
        balance is 0; the claim is in flight, so obligations are still 100. It
        cannot cover a restore, and it must not try.
        """
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=0, committed=100
            )
            == core.WITHDRAWAL_DELIVERED
        )

    def test_an_undelivered_payout_is_restored(self):
        """The bradbury case, where a failed transfer leaves the value here.

        The same contract, same claim, but the transfer never landed. The
        balance is untouched, so it covers the obligation and the entitlement
        goes back.
        """
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=100, committed=100
            )
            == core.WITHDRAWAL_RESTORED
        )

    def test_money_paid_in_meanwhile_changes_no_answer(self):
        """A bond arriving raises the balance *and* the obligation together.

        This is what reading the recipient's balance got wrong: an unrelated
        payment looked like delivery. Here it cancels out exactly.
        """
        for inbound in (1, 50, 10_000):
            assert (
                core.resolve_withdrawal(
                    elapsed_seconds=self.SETTLE,
                    held=0 + inbound,
                    committed=100 + inbound,
                )
                == core.WITHDRAWAL_DELIVERED
            ), inbound
            assert (
                core.resolve_withdrawal(
                    elapsed_seconds=self.SETTLE,
                    held=100 + inbound,
                    committed=100 + inbound,
                )
                == core.WITHDRAWAL_RESTORED
            ), inbound

    def test_a_restore_never_reaches_another_party_s_money(self):
        """The property that makes the mechanism safe rather than merely useful.

        Whatever else is outstanding — other entitlements, locked bonds, posted
        collateral — a restore is only allowed when the balance covers all of it
        with this claim included. Add a second party's 500 to the obligations
        and the same balance that restored before is refused.
        """
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=100, committed=100
            )
            == core.WITHDRAWAL_RESTORED
        )
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=100, committed=600
            )
            == core.WITHDRAWAL_DELIVERED
        )

    def test_a_slashed_bond_is_not_free_money(self):
        """The case that made the one wrong answer profitable.

        A slashed bond is never paid to anybody, so it looks like surplus. If a
        restore could reach it, a recipient whose payout *had* arrived could
        reclaim the claim as well and take the accumulated slashings. Counting
        it in `committed` is what stops that, and the arithmetic is the same
        whether the free money came from a slashing or from anywhere else: with
        it counted, a delivered claim is refused.
        """
        # 100 paid out, 100 still owed to others, and 500 of slashed bonds.
        # Without the slashings counted, held (500) covers obligations (100) and
        # the delivered claim would be restored out of them.
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=500, committed=100
            )
            == core.WITHDRAWAL_RESTORED
        ), "the arithmetic itself is unchanged; what changes is what is counted"
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=self.SETTLE, held=500, committed=100 + 500
            )
            == core.WITHDRAWAL_DELIVERED
        ), "with the slashings counted, the delivered claim is refused"

    def test_the_settle_window_is_overridable_for_tests_only(self):
        """The contract passes the constant; the parameter exists so this file
        can drive the boundary without waiting fifteen minutes."""
        assert (
            core.resolve_withdrawal(
                elapsed_seconds=5, held=1, committed=1, settle_seconds=1
            )
            == core.WITHDRAWAL_RESTORED
        )

    def test_every_outcome_is_one_of_the_declared_three(self):
        for elapsed in (0, self.SETTLE):
            for held, committed in ((0, 0), (0, 1), (1, 0), (5, 5)):
                assert (
                    core.resolve_withdrawal(
                        elapsed_seconds=elapsed, held=held, committed=committed
                    )
                    in core.WITHDRAWAL_OUTCOMES
                )
