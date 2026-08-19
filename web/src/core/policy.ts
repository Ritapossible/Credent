/**
 * Faithful TypeScript port of the `Policy` dataclass and constants in
 * `reputation_core.py`. The contract is the source of truth; this file exists so
 * the UI can show the same numbers a validator would derive rather than
 * decorative approximations of them.
 *
 * The integer-only discipline carries over for the same reason it exists in the
 * contract: a float here would let the interface quote a score the chain does not
 * agree with, which is worse than showing nothing.
 */

/** Basis points. Every ratio in the core modules is an integer out of 10000. */
export const BP = 10000

/** Neutral score: an agent with no history, and the shrinkage target. */
export const NEUTRAL_BP = 5000

/** Past this many half-lives, weight has underflowed to zero anyway. */
export const MAX_HALVINGS = 63

/** Widest collateral rate a policy may charge: a hundred times the stake. */
export const MAX_COLLATERAL_BP = 100 * BP

/** Widest value the contract's `u256` storage fields hold. */
export const U256_MAX = (1n << 256n) - 1n

export interface Policy {
  /** Age at which an attestation's weight halves. */
  halfLifeSeconds: number
  /** Strength of the neutral prior, in attestation-weight units. */
  priorWeight: number
  /** Below this, an attestation contributes no weight at all. */
  minSubstantiated: number
  /** Below this, likewise. */
  minConfidence: number
  /** Allowed leader/validator spread on each graded field. */
  confidenceTol: number
  /** Largest repeat-damping shift, so weight cannot underflow from volume alone. */
  repeatShiftCap: number
  /** Bond required for a first attestation, in base units. */
  minBond: bigint
  /** `substantiated` below this slashes the bond. */
  slashFloor: number
  /** `substantiated` at or above this releases it in full. */
  releaseFloor: number
  /** How long a releasable bond stays locked before reclaim. */
  bondLockSeconds: number
  /** Collateral an agent scoring 0 posts, in basis points of the stake. */
  collateralCeilingBp: number
  /** What the same stake costs an agent scoring 10000. */
  collateralFloorBp: number
  /** `fulfilled` below this forfeits the collateral to the client. */
  collateralForfeitBp: number
}

export const DEFAULT_POLICY: Policy = {
  halfLifeSeconds: 7_776_000, // 90 days
  priorWeight: 3 * BP,
  minSubstantiated: 25,
  minConfidence: 50,
  confidenceTol: 20,
  repeatShiftCap: 8,
  minBond: 0n,
  slashFloor: 20,
  releaseFloor: 50,
  bondLockSeconds: 1_209_600, // 14 days
  collateralCeilingBp: 15_000, // 150% of the stake at score 0
  collateralFloorBp: 2_500, // 25% of it at a perfect score
  collateralForfeitBp: 2_500, // fulfilled below 25% forfeits
}

/**
 * The policy Credent actually deploys with.
 *
 * `minBond` is the one deliberate departure from the contract defaults. At the
 * contract's `min_bond = 0` the economic layer is switched off: attesting is free,
 * so the bond curve that makes sybil attestation unprofitable never charges
 * anyone. Nothing in the scoring math changes - only whether attesting costs
 * something.
 *
 * One GEN, in wei, because the contract charges the chain's native token and
 * nothing else. This was `25_000_000n` annotated "25 USDC, 6dp", which named a
 * token no part of the contract touches and, read at the native 18 decimals the
 * chain actually uses, amounted to 0.000000000025 GEN - a bond curve that
 * doubled a rounding error.
 *
 * One is chosen to be payable rather than impressive. Studio accounts are funded
 * with about a hundred GEN, so a first attestation costs a percent of that and
 * the doubling still bites a sybil fleet by the fourth or fifth; a larger figure
 * would price honest counterparties out of a network whose tokens have no market
 * anyway. This is the number to raise first on a chain where GEN is worth
 * something.
 */
export const CREDENT_POLICY: Policy = {
  ...DEFAULT_POLICY,
  minBond: 1_000_000_000_000_000_000n, // 1 GEN, 18dp
}

/**
 * The collateral parameters are *not* among the departures above, deliberately.
 *
 * `minBond` has to be raised because the contract defaults to zero and zero
 * switches the bond off. The collateral layer has no such switch: it is on at
 * the contract defaults, and an engagement turns it off for itself by declaring
 * a stake of zero. There is nothing to override, so nothing is.
 */

export function validatePolicy(policy: Policy): void {
  if (policy.halfLifeSeconds < 1) throw new Error('halfLifeSeconds must be >= 1')
  if (policy.priorWeight < 0) throw new Error('priorWeight must be >= 0')
  if (!inRange(policy.minSubstantiated, 0, 100)) throw new Error('minSubstantiated out of range')
  if (!inRange(policy.minConfidence, 0, 100)) throw new Error('minConfidence out of range')
  if (!inRange(policy.confidenceTol, 0, 100)) throw new Error('confidenceTol out of range')
  if (!inRange(policy.repeatShiftCap, 0, MAX_HALVINGS)) throw new Error('repeatShiftCap out of range')
  if (policy.minBond < 0n) throw new Error('minBond must be >= 0')
  if (!inRange(policy.slashFloor, 0, 100)) throw new Error('slashFloor out of range')
  if (!inRange(policy.releaseFloor, 0, 100)) throw new Error('releaseFloor out of range')
  if (policy.slashFloor > policy.releaseFloor) throw new Error('slashFloor must be <= releaseFloor')
  if (policy.bondLockSeconds < 0) throw new Error('bondLockSeconds must be >= 0')
  if (!inRange(policy.collateralCeilingBp, 0, MAX_COLLATERAL_BP))
    throw new Error('collateralCeilingBp out of range')
  if (!inRange(policy.collateralFloorBp, 0, MAX_COLLATERAL_BP))
    throw new Error('collateralFloorBp out of range')
  if (policy.collateralFloorBp > policy.collateralCeilingBp)
    throw new Error('collateralFloorBp must be <= collateralCeilingBp')
  if (!inRange(policy.collateralForfeitBp, 0, BP))
    throw new Error('collateralForfeitBp out of range')
}

function inRange(value: number, lo: number, hi: number): boolean {
  return Number.isInteger(value) && value >= lo && value <= hi
}

/** Integer clamp, matching the contract's `max(0, min(hi, value))` idiom. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Right shift by division.
 *
 * JavaScript's `>>` is a 32-bit operator: `10000 >> 64` wraps the shift count and
 * returns 10000, where Python returns 0. Every shift in the ported math goes
 * through here instead. Exact for any safe integer, because dividing by a power
 * of two only adjusts the binary exponent.
 */
export function shr(value: number, bits: number): number {
  if (bits <= 0) return value
  if (bits >= 53) return 0
  return Math.floor(value / 2 ** bits)
}
