"""Generate the cross-language parity vectors.

`web/src/core/` is a TypeScript port of `reputation_core.py`. The UI shows scores
computed by the port, and a consumer reading the same agent off-chain gets scores
computed by the engine. Two implementations of one piece of consensus arithmetic
is a drift problem, and the drift would be invisible: both sides would keep
producing plausible integers, just not the same ones.

So the two are pinned against each other. This script evaluates the Python engine
over a fixed grid of inputs and writes `parity_vectors.json`;
`web/scripts/parity.ts` runs the TypeScript port over the identical grid and
fails if any value differs. Neither side can move alone.

The grid is enumerated, not sampled. A random sweep with a seed is reproducible
but says nothing about *why* those points; these are chosen to sit on the edges
that integer arithmetic actually breaks at - the floors, the shift cap, zero and
maximum age, the exact boundary values of every clamp - plus enough interior
points to catch a wrong operator. `random` is also unavailable to the contract
runtime, and keeping the tooling to the same discipline means a vector can be
moved into a contract test without rewriting it.

Run after touching either implementation; `test_parity_vectors.py` fails the
suite if the checked-in file is stale.
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

from reputation_core import (
    BP,
    Policy,
    aggregate,
    attestation_salt,
    attestation_weight,
    bond_outcome,
    bond_required,
    decay_bp,
    normalize_address,
    repeat_shift,
    scope_digest,
)

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "parity_vectors.json"

DAY = 86400

# The two policies the UI actually runs on. `CREDENT_POLICY` in the port differs
# from the contract defaults in `min_bond` alone, which is the one parameter that
# switches the economic layer on - so a bond curve compared only against the
# defaults would compare `0` to `0` forever and prove nothing.
DEFAULT_POLICY = Policy()
CREDENT_POLICY = replace(DEFAULT_POLICY, min_bond=25_000_000)  # mirrors the port's

POLICIES = {"default": DEFAULT_POLICY, "credent": CREDENT_POLICY}


def _policy_as_dict(policy: Policy) -> dict:
    """The camelCase spelling the TypeScript `Policy` uses.

    The port renames the fields and nothing else, so the mapping is written out
    here rather than derived: a generated `snake_to_camel` would silently invent
    a field name if either side ever added one.
    """
    return {
        "halfLifeSeconds": policy.half_life_seconds,
        "priorWeight": policy.prior_weight,
        "minSubstantiated": policy.min_substantiated,
        "minConfidence": policy.min_confidence,
        "confidenceTol": policy.confidence_tol,
        "repeatShiftCap": policy.repeat_shift_cap,
        "minBond": str(policy.min_bond),  # bigint on the other side
        "slashFloor": policy.slash_floor,
        "releaseFloor": policy.release_floor,
        "bondLockSeconds": policy.bond_lock_seconds,
    }


# --- input grids ------------------------------------------------------------

# Ages that matter: zero, a fraction of a half-life, exact half-lives (where the
# shift is whole and the interpolation term vanishes), just either side of one,
# and far enough out that the weight has floored.
AGES = [
    0,
    1,
    DAY,
    30 * DAY,
    DEFAULT_POLICY.half_life_seconds - 1,
    DEFAULT_POLICY.half_life_seconds,
    DEFAULT_POLICY.half_life_seconds + 1,
    2 * DEFAULT_POLICY.half_life_seconds,
    3 * DEFAULT_POLICY.half_life_seconds,
    10 * DEFAULT_POLICY.half_life_seconds,
    100 * DEFAULT_POLICY.half_life_seconds,
]

# Substantiation and confidence: both floors exactly, one below each, the ends of
# the range, and interior points that are not multiples of ten.
SUBSTANTIATED = [0, 1, 19, 20, 24, 25, 26, 37, 50, 63, 99, 100]
CONFIDENCE = [0, 1, 49, 50, 51, 73, 100]

# Repeat indexes bracketing the shift cap on both sides.
REPEATS = [0, 1, 2, 3, 7, 8, 9, 15, 64]

# Weights spanning the basis-point range, including values that are not clean
# powers of two so a shift/divide confusion shows up.
WEIGHTS = [0, 1, 3, 1000, 4999, 5000, 9999, BP]


def _decay_vectors() -> list[dict]:
    return [
        {
            "weight": weight,
            "ageSeconds": age,
            "halfLifeSeconds": half_life,
            "expected": decay_bp(weight, age, half_life),
        }
        for weight in WEIGHTS
        for age in AGES
        for half_life in (1, DAY, DEFAULT_POLICY.half_life_seconds)
    ]


def _repeat_shift_vectors() -> list[dict]:
    return [
        {
            "repeatIndex": repeat,
            "policy": name,
            "expected": repeat_shift(repeat, policy),
        }
        for name, policy in POLICIES.items()
        for repeat in REPEATS
    ]


def _weight_vectors() -> list[dict]:
    return [
        {
            "substantiated": substantiated,
            "confidence": confidence,
            "repeatIndex": repeat,
            "ageSeconds": age,
            "policy": name,
            "expected": attestation_weight(
                substantiated=substantiated,
                confidence=confidence,
                repeat_index=repeat,
                age_seconds=age,
                policy=policy,
            ),
        }
        for name, policy in POLICIES.items()
        for substantiated in SUBSTANTIATED
        for confidence in CONFIDENCE
        for repeat in (0, 1, 3, 9)
        for age in (0, 30 * DAY, DEFAULT_POLICY.half_life_seconds, 5 * DEFAULT_POLICY.half_life_seconds)
    ]


# Attestation sets chosen for the shapes the prior is meant to handle: nothing at
# all, a single glowing review, a crowd of weak ones, and a mix that straddles
# the neutral point.
ENTRY_SETS: list[list[tuple[int, int]]] = [
    [],
    [(BP, BP)],
    [(BP, 0)],
    [(BP, NEUTRAL) for NEUTRAL in (5000,)],
    [(0, BP)],  # zero-weight entries must not count toward the total
    [(1, BP), (1, 0)],
    [(BP, BP), (BP, BP), (BP, BP)],
    [(2500, 9000), (1250, 3000), (625, 10000)],
    [(9999, 4999), (1, 1)],
    [(BP, 12345)],  # grade above BP is clamped, not trusted
    [(BP, -5)],  # and below zero likewise
]


def _aggregate_vectors() -> list[dict]:
    vectors = []
    for name, policy in POLICIES.items():
        for entries in ENTRY_SETS:
            score_bp, total_weight = aggregate(entries, policy)
            vectors.append(
                {
                    "entries": [list(entry) for entry in entries],
                    "policy": name,
                    "expected": {"scoreBp": score_bp, "totalWeight": total_weight},
                }
            )
    return vectors


def _bond_required_vectors() -> list[dict]:
    return [
        {
            "repeatIndex": repeat,
            "policy": name,
            # Stringified: these exceed `Number.MAX_SAFE_INTEGER` well before the
            # shift cap, and JSON numbers on the other side are doubles.
            "expected": str(bond_required(repeat, policy)),
        }
        for name, policy in POLICIES.items()
        for repeat in REPEATS
    ]


# Grades covering both keys `bond_outcome` reads, plus the malformed shapes it
# promises to absorb rather than raise on.
GRADES: list[object] = [
    {"verdict": "fulfilled", "substantiated": 100},
    {"verdict": "fulfilled", "substantiated": 20},
    {"verdict": "fulfilled", "substantiated": 19},
    {"verdict": "fulfilled", "substantiated": 0},
    {"verdict": "unfulfilled", "substantiated": 95},
    {"verdict": "unfulfilled", "substantiated": 0},
    {"verdict": "ungraded", "substantiated": 0},
    {"verdict": "ungraded", "substantiated": 100},
    {"verdict": "partial", "substantiated": 25},
    {"substantiated": 10},
    {"verdict": "fulfilled"},
    {},
]


def _bond_outcome_vectors() -> list[dict]:
    return [
        {"grade": grade, "policy": name, "expected": bond_outcome(grade, policy)}
        for name, policy in POLICIES.items()
        for grade in GRADES
    ]


# Strings chosen for the encoding boundary: ASCII, characters that JSON escapes,
# non-ASCII that `ensure_ascii=True` escapes and `JSON.stringify` does not, and an
# astral character that only matches if the port escapes per UTF-16 code unit.
SCOPES = [
    "",
    "Deliver a settlement routing integration by 2026-09-01.",
    'quotes " and \\ backslash',
    "tab\tnewline\ncarriage\rreturn",
    "café naïve über",
    "中文テキスト",
    "emoji \U0001f600 and \U0001f4a9",
    "control ",
    " leading and trailing ",
]

ADDRESSES = [
    "0x7a3f9c2e5b8d1a4f6c0e9b2d7a5f3c1e8b6d4a29",
    "0x7A3F9C2E5B8D1A4F6C0E9B2D7A5F3C1E8B6D4A29",
    "  0xABCDEF0123456789abcdef0123456789ABCDEF01  ",
    "",
]


def _scope_digest_vectors() -> list[dict]:
    return [{"scope": scope, "expected": scope_digest(scope)} for scope in SCOPES]


def _normalize_address_vectors() -> list[dict]:
    return [
        {"text": address, "expected": normalize_address(address)} for address in ADDRESSES
    ]


def _salt_vectors() -> list[dict]:
    vectors = []
    for scope in SCOPES:
        for attester, subject in zip(ADDRESSES, ADDRESSES[1:] + ADDRESSES[:1]):
            for claim in ("", "delivered on time", "emoji \U0001f600 claim"):
                vectors.append(
                    {
                        "scope": scope,
                        "attester": attester,
                        "subject": subject,
                        "claim": claim,
                        "expected": attestation_salt(
                            scope=scope,
                            attester=attester,
                            subject=subject,
                            claim=claim,
                        ),
                    }
                )
    return vectors


def render() -> str:
    """The full text of the generated vector file."""
    document = {
        "_comment": (
            "GENERATED by parity_vectors.py - do not edit. Expected values come "
            "from reputation_core.py; web/scripts/parity.ts checks the TypeScript "
            "port against them."
        ),
        "policies": {name: _policy_as_dict(policy) for name, policy in POLICIES.items()},
        "decayBp": _decay_vectors(),
        "repeatShift": _repeat_shift_vectors(),
        "attestationWeight": _weight_vectors(),
        "aggregate": _aggregate_vectors(),
        "bondRequired": _bond_required_vectors(),
        "bondOutcome": _bond_outcome_vectors(),
        "normalizeAddress": _normalize_address_vectors(),
        "scopeDigest": _scope_digest_vectors(),
        "attestationSalt": _salt_vectors(),
    }
    return json.dumps(document, indent=2, ensure_ascii=True, sort_keys=False) + "\n"


def main() -> int:
    rendered = render()
    current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else None
    if current == rendered:
        print(f"{OUTPUT.name} already up to date")
        return 0
    OUTPUT.write_text(rendered, encoding="utf-8", newline="\n")
    total = sum(
        len(value)
        for value in json.loads(rendered).values()
        if isinstance(value, list)
    )
    print(f"wrote {OUTPUT.name} ({total} vectors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
