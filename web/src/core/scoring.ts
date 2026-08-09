/**
 * Port of the scoring half of `reputation_core.py`: decay, repeat damping,
 * attestation weight, and shrunk aggregation.
 *
 * Every function here is a line-for-line translation. Where JavaScript semantics
 * differ from Python's the difference is bridged explicitly (see `shr` in
 * `policy.ts`) rather than papered over, because the whole point of computing
 * these client-side is to agree with the chain.
 */

import { BP, NEUTRAL_BP, MAX_HALVINGS, clamp, shr, validatePolicy, type Policy } from './policy'

/**
 * Exponential decay by half-life, in integer arithmetic.
 *
 * Whole halvings are a shift; the remainder is linearly interpolated between the
 * two neighbouring halvings rather than truncated down, so the curve is a ramp
 * and not a staircase an agent could time a submission around.
 *
 * Monotonically non-increasing in age, exactly `weight` at age 0. Negative ages
 * clamp to 0 — a timestamp newer than the block time is clock skew, not evidence
 * an attestation is worth more than when it was written.
 */
export function decayBp(weight: number, ageSeconds: number, halfLifeSeconds: number): number {
  if (halfLifeSeconds < 1) throw new Error('halfLifeSeconds must be >= 1')
  if (weight <= 0) return 0
  if (ageSeconds <= 0) return weight

  const periods = Math.floor(ageSeconds / halfLifeSeconds)
  if (periods > MAX_HALVINGS) return 0

  const remainder = ageSeconds % halfLifeSeconds
  const hi = shr(weight, periods)
  const lo = shr(weight, periods + 1)
  return hi - Math.floor(((hi - lo) * remainder) / halfLifeSeconds)
}

/**
 * Damping shift for the k-th attestation from one attester about one subject.
 *
 * The first is undamped; each subsequent one is worth half the last, capped so a
 * prolific-but-honest counterparty does not underflow to nothing.
 */
export function repeatShift(repeatIndex: number, policy: Policy): number {
  if (repeatIndex <= 0) return 0
  return Math.min(repeatIndex, policy.repeatShiftCap)
}

export interface WeightInput {
  substantiated: number
  confidence: number
  repeatIndex: number
  ageSeconds: number
  policy: Policy
}

/**
 * What one attestation is worth, in basis points.
 *
 * Floors, then substantiation, then repeat damping, then decay. Confidence gates
 * but does not scale: it is the model's certainty about its own reading, so
 * letting it scale would make the score track model hesitancy as much as
 * evidence.
 */
export function attestationWeight({
  substantiated,
  confidence,
  repeatIndex,
  ageSeconds,
  policy,
}: WeightInput): number {
  validatePolicy(policy)

  if (!Number.isInteger(substantiated)) return 0
  if (!Number.isInteger(confidence)) return 0
  if (substantiated < policy.minSubstantiated) return 0
  if (confidence < policy.minConfidence) return 0

  const base = Math.floor((BP * clamp(substantiated, 0, 100)) / 100)
  const damped = shr(base, repeatShift(repeatIndex, policy))
  return decayBp(damped, ageSeconds, policy.halfLifeSeconds)
}

/**
 * The stepwise reason an attestation ended up at the weight it did.
 *
 * Not in the contract — the contract only needs the number. The interface needs
 * to explain it, and an explanation assembled separately from the calculation
 * would eventually drift from it. `weight` here is the same value
 * `attestationWeight` returns, computed by the same steps.
 */
export interface WeightBreakdown {
  gatedBy: 'substantiated' | 'confidence' | null
  base: number
  afterRepeat: number
  weight: number
  repeatShiftBits: number
  decayLossBp: number
}

export function explainWeight({
  substantiated,
  confidence,
  repeatIndex,
  ageSeconds,
  policy,
}: WeightInput): WeightBreakdown {
  validatePolicy(policy)

  const empty: WeightBreakdown = {
    gatedBy: null,
    base: 0,
    afterRepeat: 0,
    weight: 0,
    repeatShiftBits: 0,
    decayLossBp: 0,
  }

  if (substantiated < policy.minSubstantiated) return { ...empty, gatedBy: 'substantiated' }
  if (confidence < policy.minConfidence) return { ...empty, gatedBy: 'confidence' }

  const bits = repeatShift(repeatIndex, policy)
  const base = Math.floor((BP * clamp(substantiated, 0, 100)) / 100)
  const afterRepeat = shr(base, bits)
  const weight = decayBp(afterRepeat, ageSeconds, policy.halfLifeSeconds)

  return {
    gatedBy: null,
    base,
    afterRepeat,
    weight,
    repeatShiftBits: bits,
    decayLossBp: afterRepeat - weight,
  }
}

/** An agent's standing, as reported to consumers. Mirrors the contract's `Report`. */
export interface Report {
  scoreBp: number
  totalWeight: number
  nAttestations: number
  nDistinctAttesters: number
  nCounted: number
}

/**
 * Shrunk weighted mean of graded attestations.
 *
 *   score = (sum(wi * gi) + priorWeight * NEUTRAL) / (sum(wi) + priorWeight)
 *
 * The prior is what stops a single attestation from producing a perfect agent.
 * An agent with no attestations scores exactly NEUTRAL_BP: unknown is distinct
 * from bad.
 */
export function aggregate(
  entries: Iterable<readonly [number, number]>,
  policy: Policy,
): { scoreBp: number; totalWeight: number } {
  validatePolicy(policy)

  let weightedSum = 0
  let totalWeight = 0
  for (const [weight, grade] of entries) {
    if (weight <= 0) continue
    weightedSum += weight * clamp(grade, 0, BP)
    totalWeight += weight
  }

  const denominator = totalWeight + policy.priorWeight
  if (denominator <= 0) return { scoreBp: NEUTRAL_BP, totalWeight: 0 }

  const numerator = weightedSum + policy.priorWeight * NEUTRAL_BP
  return { scoreBp: Math.floor(numerator / denominator), totalWeight }
}
