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
}

/**
 * The policy Credent actually deploys with.
 *
 * `minBond` is the one deliberate departure from the contract defaults. At the
 * contract's `min_bond = 0` the economic layer is switched off: attesting is free,
 * so the bond curve that makes sybil attestation unprofitable never charges
 * anyone. Nothing in the scoring math changes - only whether attesting costs
 * something.
 */
export const CREDENT_POLICY: Policy = {
  ...DEFAULT_POLICY,
  minBond: 25_000_000n, // 25 USDC, 6dp
}

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
