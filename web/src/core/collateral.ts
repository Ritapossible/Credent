/**
 * Port of the work-collateral half of `reputation_core.py`.
 *
 * This is the mechanism the score exists for, and it is not the bond in
 * `bonding.ts`. The bond prices *attesting* - posted by an attester, doubling
 * per repeat. Collateral prices *working* - posted by the agent taking the job,
 * falling as that agent's score rises. `collateralRequired` is the conversion
 * the whole protocol is built around: `getReport(...).scoreBp` in, money the
 * agent has to find before a counterparty will hand them work out.
 *
 * Amounts are `bigint` for the same reason bonds are: a stake is denominated in
 * wei, so at 18 decimals any realistic engagement already exceeds
 * `Number.MAX_SAFE_INTEGER`, and a float rounding at the top end would misquote
 * what an agent has to post.
 */

import { BP, U256_MAX, clamp, validatePolicy, type Policy } from './policy'
import { VERDICT_UNGRADED } from './bonding'

export const COLLATERAL_RELEASABLE = 'releasable'
export const COLLATERAL_FORFEIT = 'forfeit'
export type CollateralOutcome = typeof COLLATERAL_RELEASABLE | typeof COLLATERAL_FORFEIT

/**
 * Collateral rate for an agent at `scoreBp`, in basis points of the stake.
 *
 * A straight line from `collateralCeilingBp` at a score of zero to
 * `collateralFloorBp` at a perfect one. Linear rather than a curve with more
 * opinion in it, because every point on it has to be explainable to the agent
 * being charged: at the deployed policy an unknown agent posts 87.5% of the
 * stake, a strong one at 8000 posts 50%, and the best possible record still
 * posts a quarter. Nobody reaches zero - a reputation earns a discount, and a
 * discount is not an exemption.
 *
 * The score is clamped rather than trusted. `aggregate` cannot return one
 * outside [0, BP], but this is also called with a score a caller supplied.
 */
export function collateralRateBp(scoreBp: number, policy: Policy): number {
  validatePolicy(policy)

  const score = typeof scoreBp === 'number' && Number.isInteger(scoreBp) ? clamp(scoreBp, 0, BP) : 0
  const span = policy.collateralCeilingBp - policy.collateralFloorBp
  return policy.collateralCeilingBp - Math.floor((span * score) / BP)
}

/**
 * What an agent at `scoreBp` must post to take on work worth `stake`.
 *
 * Rounds down, like every other ratio in the ported math: a caller who sends
 * exactly what they were quoted must never be rejected for a unit of rounding.
 *
 * A stake of zero prices at zero, which is what makes an engagement that
 * declares no value behave exactly as the lifecycle did before it had a
 * collateral layer.
 */
export function collateralRequired(scoreBp: number, stake: bigint, policy: Policy): bigint {
  validatePolicy(policy)

  if (typeof stake !== 'bigint' || stake <= 0n) return 0n
  return (stake * BigInt(collateralRateBp(scoreBp, policy))) / BigInt(BP)
}

/**
 * Largest stake whose collateral still fits in a `u256`.
 *
 * The ceiling rate can exceed BP - collateral worth more than the work is a
 * legitimate policy for an agent with no record - so a stake that fits in
 * storage does not imply the collateral derived from it does. The contract
 * rejects anything past this at open time; quoting the same bound here means the
 * site can refuse it before the gas rather than after.
 */
export function maxStake(policy: Policy): bigint {
  validatePolicy(policy)

  const rate = policy.collateralCeilingBp
  if (rate <= BP) return U256_MAX
  return (U256_MAX * BigInt(BP)) / BigInt(rate)
}

/**
 * Whether the provider's collateral comes back.
 *
 * Keyed on `fulfilled` - the opposite of `bondOutcome`, and for the opposite
 * reason. The bond asks whether an attester asserted without support, so it
 * reads substantiation and never sentiment. The collateral asks whether the work
 * was delivered, which is exactly what `fulfilled` measures.
 *
 * Two gates stand in front of that, and both are the gate the score already
 * applies: substantiated at or above `releaseFloor`, confident at or above
 * `minConfidence`. An attestation that carries no weight in the score must not
 * be able to take an agent's money either - otherwise the cheapest attack on the
 * contract is an unevidenced accusation.
 */
export function collateralOutcome(
  grade:
    | { verdict?: unknown; fulfilled?: unknown; substantiated?: unknown; confidence?: unknown }
    | null
    | undefined,
  policy: Policy,
): CollateralOutcome {
  validatePolicy(policy)

  if (grade === null || typeof grade !== 'object') return COLLATERAL_RELEASABLE
  if (grade.verdict === VERDICT_UNGRADED) return COLLATERAL_RELEASABLE

  const { substantiated, confidence, fulfilled } = grade
  for (const value of [substantiated, confidence, fulfilled]) {
    if (typeof value !== 'number' || !Number.isInteger(value)) return COLLATERAL_RELEASABLE
  }

  if ((substantiated as number) < policy.releaseFloor) return COLLATERAL_RELEASABLE
  if ((confidence as number) < policy.minConfidence) return COLLATERAL_RELEASABLE
  return (fulfilled as number) < policy.collateralForfeitBp
    ? COLLATERAL_FORFEIT
    : COLLATERAL_RELEASABLE
}
