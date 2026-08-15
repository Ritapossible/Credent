"""Guards on the cross-language parity vectors.

`parity_vectors.json` is what pins the TypeScript port in `web/src/core/` to the
Python engine. It is a generated file, so it can go stale, and a stale one is
worse than none: `npm run parity` would keep passing against expectations that no
longer describe the engine, which is precisely the drift the vectors exist to
catch.

These tests do not run the TypeScript. That is `npm run parity`'s job. What is
checkable here is that the file on disk is the file the current engine produces,
and that it still covers the inputs worth covering.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import parity_vectors
from reputation_core import BP

ROOT = Path(__file__).resolve().parent
VECTORS = ROOT / "parity_vectors.json"

# Every family the generator emits and the TypeScript runner checks. Listed
# rather than derived, so deleting a family from the generator fails here instead
# of quietly shrinking what parity means.
FAMILIES = (
    "decayBp",
    "repeatShift",
    "attestationWeight",
    "aggregate",
    "bondRequired",
    "bondOutcome",
    "normalizeAddress",
    "scopeDigest",
    "attestationSalt",
)


@pytest.fixture(scope="module")
def document() -> dict:
    if not VECTORS.exists():
        pytest.fail("parity_vectors.json is missing - run `python parity_vectors.py`")
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_vectors_match_the_current_engine() -> None:
    """The checked-in file is what the engine generates right now."""
    assert VECTORS.read_text(encoding="utf-8") == parity_vectors.render(), (
        "parity_vectors.json is stale. Run `python parity_vectors.py` and commit "
        "the result, then re-run `npm run parity` in web/."
    )


def test_every_family_is_present_and_populated(document: dict) -> None:
    """A family that silently became empty would pass parity by vacuity."""
    for family in FAMILIES:
        assert family in document, f"missing vector family: {family}"
        assert len(document[family]) > 0, f"empty vector family: {family}"


def test_policies_carry_min_bond_as_a_string(document: dict) -> None:
    """`min_bond` crosses the boundary as a decimal string, not a JSON number.

    It is a `bigint` on the TypeScript side and doubles per repeat, so the bond
    curve exceeds `Number.MAX_SAFE_INTEGER` several steps before the shift cap.
    Passing it as a JSON number would round both sides into agreeing.
    """
    for name, policy in document["policies"].items():
        assert isinstance(policy["minBond"], str), f"{name}: minBond must be a string"
        int(policy["minBond"])  # parses as an integer

    for vector in document["bondRequired"]:
        assert isinstance(vector["expected"], str)


def test_the_bonded_policy_actually_charges(document: dict) -> None:
    """One policy must have a non-zero `min_bond`.

    At `min_bond = 0` every `bond_required` is zero, so a bond curve compared
    only against the contract defaults would compare 0 to 0 across the whole grid
    and prove nothing about the shift.
    """
    bonds = {int(policy["minBond"]) for policy in document["policies"].values()}
    assert any(bond > 0 for bond in bonds), "no policy exercises the bond curve"


def test_weight_vectors_straddle_both_floors(document: dict) -> None:
    """The floors are where `attestation_weight` changes shape.

    Above them weight is proportional to substantiation; below either one it is
    exactly zero. A grid that only sampled one side would miss a port that
    dropped a gate entirely.
    """
    weights = document["attestationWeight"]
    assert any(vector["expected"] == 0 for vector in weights), "no gated-out vectors"
    assert any(vector["expected"] > 0 for vector in weights), "no counted vectors"

    substantiated = {vector["substantiated"] for vector in weights}
    confidence = {vector["confidence"] for vector in weights}
    default = document["policies"]["default"]
    assert {default["minSubstantiated"] - 1, default["minSubstantiated"]} <= substantiated
    assert {default["minConfidence"] - 1, default["minConfidence"]} <= confidence


def test_decay_vectors_reach_full_and_floored_weight(document: dict) -> None:
    """Age zero must not decay, and a long enough age must floor.

    Both ends are easy to get wrong in a port - an off-by-one in the halving
    count shows up at exactly one of them - and neither is reachable from the
    interior of the grid.
    """
    decay = document["decayBp"]
    assert any(
        vector["ageSeconds"] == 0 and vector["expected"] == vector["weight"]
        for vector in decay
    ), "no undecayed vector"
    assert any(
        vector["ageSeconds"] > 0 and vector["expected"] == 0 and vector["weight"] > 0
        for vector in decay
    ), "no fully decayed vector"


def test_aggregate_covers_the_empty_case(document: dict) -> None:
    """No attestations must score exactly neutral, not zero.

    Unknown is distinct from bad. A port that returned 0 here would rank every
    new agent below every badly reviewed one.
    """
    empty = [vector for vector in document["aggregate"] if vector["entries"] == []]
    assert empty, "no empty-entry aggregate vector"
    for vector in empty:
        assert vector["expected"]["scoreBp"] == BP // 2
        assert vector["expected"]["totalWeight"] == 0


def test_digest_vectors_cover_non_ascii_and_astral_characters(document: dict) -> None:
    """The encoding boundary is where the two hashers can disagree.

    Python's `ensure_ascii=True` escapes non-ASCII; `JSON.stringify` does not.
    The port re-escapes per UTF-16 code unit to compensate, and an astral
    character is the only input that distinguishes a correct implementation of
    that from one that escapes per code *point*.
    """
    scopes = {vector["scope"] for vector in document["scopeDigest"]}
    assert any(any(ord(ch) > 127 for ch in scope) for scope in scopes), "all-ASCII grid"
    assert any(any(ord(ch) > 0xFFFF for ch in scope) for scope in scopes), (
        "no astral character in the digest grid"
    )
