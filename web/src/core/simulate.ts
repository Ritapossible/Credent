/**
 * What it costs to buy a score.
 *
 * The scoring and bonding curves move in opposite directions: weight halves per
 * repeat while the bond doubles. This module turns that into the number the
 * attack page is actually about — cost per unit of weight — for the two shapes an
 * attack can take.
 *
 * Every figure here is derived by calling `aggregate` and `bondRequired`, never by
 * re-deriving their arithmetic. A closed form seeds the search; the real function
 * decides the answer, so the page cannot quote a score the contract disagrees
 * with.
 */

import { aggregate, repeatShift, type Report } from './scoring'
import { bondRequired } from './bonding'
import { BP, NEUTRAL_BP, clamp, shr, type Policy } from './policy'

/** Weight of a fresh, fully substantiated first attestation. */
export const FULL_WEIGHT = BP

/**
 * Total weight required to pull a neutral agent to `targetBp`, from the shrunk
 * mean solved for `sum(w)`:
 *
 *   sum(w) = priorWeight * (T - NEUTRAL) / (G - T)
 *
 * Returns `null` when the target is unreachable at that grade — at `T >= G` the
 * denominator is zero or negative, and no amount of weight gets there.
 */
export function weightNeededFor(targetBp: number, gradeBp: number, policy: Policy): number | null {
  if (targetBp <= NEUTRAL_BP) return 0
  if (gradeBp <= targetBp) return null
  const needed = (policy.priorWeight * (targetBp - NEUTRAL_BP)) / (gradeBp - targetBp)
  return Math.ceil(needed)
}

/** Score an agent would report given `count` attestations each of `weight` at `grade`. */
export function scoreFor(count: number, weight: number, gradeBp: number, policy: Policy): number {
  if (count <= 0) return NEUTRAL_BP
  const entries: Array<readonly [number, number]> = [[weight * count, gradeBp]]
  return aggregate(entries, policy).scoreBp
}

export interface AttackPath {
  /** Attestations required, or null if the target cannot be reached this way. */
  count: number | null
  /** Total bond posted across those attestations. */
  totalBond: bigint
  /** Score actually reached, from `aggregate`. */
  reachedBp: number
}

/**
 * One fresh attester per attestation — the cheapest shape, and the one the bond
 * curve cannot punish: every attestation is a first attestation, so every bond is
 * `minBond` flat.
 *
 * This is the honest path's cost too. That is the point: Credent does not make
 * attesting expensive, it makes *repeating* expensive.
 */
export function sybilFleetPath(targetBp: number, gradeBp: number, policy: Policy): AttackPath {
  const needed = weightNeededFor(targetBp, gradeBp, policy)
  if (needed === null) return { count: null, totalBond: 0n, reachedBp: NEUTRAL_BP }

  let count = Math.max(1, Math.ceil(needed / FULL_WEIGHT))
  // The closed form works in exact rationals; `aggregate` floors. Advance until
  // the real function agrees rather than trusting the estimate.
  while (count < MAX_SEARCH && scoreFor(count, FULL_WEIGHT, gradeBp, policy) < targetBp) count += 1

  const reachedBp = scoreFor(count, FULL_WEIGHT, gradeBp, policy)
  if (reachedBp < targetBp) return { count: null, totalBond: 0n, reachedBp }

  return {
    count,
    totalBond: bondRequired(0, policy) * BigInt(count),
    reachedBp,
  }
}

const MAX_SEARCH = 100_000

/**
 * One attester, attesting repeatedly.
 *
 * Weight halves per repeat until `repeatShiftCap`, then stays flat at
 * `BP >> cap` — so the target is still reachable, just at a bond that doubled its
 * way to `minBond << cap` and stays there. The ceiling is economic, not
 * arithmetic, which is the honest way to state it.
 */
export function repeatPath(targetBp: number, gradeBp: number, policy: Policy): AttackPath {
  const needed = weightNeededFor(targetBp, gradeBp, policy)
  if (needed === null) return { count: null, totalBond: 0n, reachedBp: NEUTRAL_BP }

  let totalWeight = 0
  let totalBond = 0n
  let count = 0

  while (count < MAX_SEARCH) {
    const entries: Array<readonly [number, number]> = [[totalWeight, gradeBp]]
    if (totalWeight > 0 && aggregate(entries, policy).scoreBp >= targetBp) break
    totalWeight += shr(FULL_WEIGHT, repeatShift(count, policy))
    totalBond += bondRequired(count, policy)
    count += 1
  }

  const reachedBp = aggregate([[totalWeight, gradeBp]] as const, policy).scoreBp
  if (reachedBp < targetBp) return { count: null, totalBond: 0n, reachedBp }
  return { count, totalBond, reachedBp }
}

/**
 * How much more the repeat path costs per unit of weight bought.
 *
 * The ratio, not the difference: it is scale-free, so it holds whatever `minBond`
 * is set to, and it is the quantity that makes the sybil argument.
 */
export function repeatPenalty(policy: Policy): number {
  const cappedBond = bondRequired(policy.repeatShiftCap, policy)
  const cappedWeight = shr(FULL_WEIGHT, policy.repeatShiftCap)
  const firstBond = bondRequired(0, policy)
  if (firstBond <= 0n || cappedWeight <= 0) return 0

  // Bonds are bigint; scale before dividing so the ratio keeps its precision.
  const ratio = (cappedBond * BigInt(FULL_WEIGHT) * 1000n) / (firstBond * BigInt(cappedWeight))
  return Number(ratio) / 1000
}

export interface CostPoint {
  targetBp: number
  fleetCount: number | null
  fleetBond: bigint
  repeatCount: number | null
  repeatBond: bigint
}

/** Cost of each path across a sweep of target scores, for the attack chart. */
export function costCurve(gradeBp: number, policy: Policy, steps = 18): CostPoint[] {
  const lo = NEUTRAL_BP + 250
  const hi = Math.min(gradeBp - 100, 9800)
  const points: CostPoint[] = []

  for (let i = 0; i <= steps; i += 1) {
    const targetBp = Math.round(lo + ((hi - lo) * i) / steps)
    const fleet = sybilFleetPath(targetBp, gradeBp, policy)
    const repeat = repeatPath(targetBp, gradeBp, policy)
    points.push({
      targetBp,
      fleetCount: fleet.count,
      fleetBond: fleet.totalBond,
      repeatCount: repeat.count,
      repeatBond: repeat.totalBond,
    })
  }
  return points
}

/** A full report for a hypothetical set of attestations, mirroring the contract. */
export function reportFor(
  entries: Array<{ weight: number; gradeBp: number; attester: string }>,
  policy: Policy,
): Report {
  const counted = entries.filter((entry) => entry.weight > 0)
  const { scoreBp, totalWeight } = aggregate(
    counted.map((entry) => [entry.weight, clamp(entry.gradeBp, 0, BP)] as const),
    policy,
  )
  return {
    scoreBp,
    totalWeight,
    nAttestations: entries.length,
    nDistinctAttesters: new Set(entries.map((entry) => entry.attester)).size,
    nCounted: counted.length,
  }
}
