/**
 * Port of the bonding half of `reputation_core.py`.
 *
 * Bond amounts are `bigint` here, unlike the rest of the ported math. They are
 * token base units, so at 18 decimals a bond of a few thousand tokens already
 * exceeds `Number.MAX_SAFE_INTEGER` - and `bondRequired` doubles it per repeat on
 * top of that. A float rounding at the top end would misquote what an attester
 * has to post.
 */

import { repeatShift } from './scoring'
import { validatePolicy, type Policy } from './policy'

export const BOND_RELEASABLE = 'releasable'
export const BOND_SLASHED = 'slashed'
export type BondOutcome = typeof BOND_RELEASABLE | typeof BOND_SLASHED

export const VERDICT_FULFILLED = 'fulfilled'
export const VERDICT_PARTIAL = 'partial'
export const VERDICT_UNFULFILLED = 'unfulfilled'
export const VERDICT_UNGRADED = 'ungraded'

export const VERDICTS = [
  VERDICT_FULFILLED,
  VERDICT_PARTIAL,
  VERDICT_UNFULFILLED,
  VERDICT_UNGRADED,
] as const

export type Verdict = (typeof VERDICTS)[number]

/**
 * Bond for the k-th attestation from one attester about one subject.
 *
 * Doubles per repeat, mirroring the halving in `repeatShift`. The two curves move
 * in opposite directions deliberately: a sock-puppet farm pays geometrically more
 * for attestations worth geometrically less, so cost per unit of score moved
 * rises as the square. That relationship is the entire economic argument against
 * buying reputation, and `AttackSimulator` in the UI plots exactly this.
 */
export function bondRequired(repeatIndex: number, policy: Policy): bigint {
  validatePolicy(policy)
  if (policy.minBond <= 0n) return 0n
  return policy.minBond << BigInt(repeatShift(repeatIndex, policy))
}

/**
 * Whether the attester's bond comes back.
 *
 * Keyed on `substantiated`, never on `fulfilled`. Slashing a negative review
 * would make honest criticism expensive and turn the oracle into a praise
 * machine; slashing an unsubstantiated one charges for asserting without support,
 * which is the actual sybil behaviour. A scathing, well-evidenced attestation is
 * never at risk.
 *
 * An ungraded response releases rather than slashes: a response the contract
 * could not read is evidence about the model, not about the attester.
 */
export function bondOutcome(
  grade: { verdict?: unknown; substantiated?: unknown } | null | undefined,
  policy: Policy,
): BondOutcome {
  validatePolicy(policy)
  if (grade === null || typeof grade !== 'object') return BOND_RELEASABLE
  if (grade.verdict === VERDICT_UNGRADED) return BOND_RELEASABLE
  const substantiated = grade.substantiated
  if (typeof substantiated !== 'number' || !Number.isInteger(substantiated)) return BOND_RELEASABLE
  return substantiated < policy.slashFloor ? BOND_SLASHED : BOND_RELEASABLE
}
