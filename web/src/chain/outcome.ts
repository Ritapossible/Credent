/**
 * Reading what the network decided actually happened.
 *
 * Split out of `wallet.ts` because two callers need it and only one of them is a
 * browser. The site reads outcomes to tell a visitor whether their write landed;
 * `scripts/settlement.ts` reads them under plain Node to verify that a payout
 * transaction did what the contract asked. A second copy for the script would be
 * the same drift this repository already refuses everywhere else - the copy that
 * rots is always the one nobody runs - so there is one implementation and both
 * import it.
 *
 * Nothing here touches `window`, and nothing here is allowed to.
 */

import type { GenLayerTransaction } from 'genlayer-js/types'

export interface Outcome {
  /** False when the contract rejected the call, however the node spelled it. */
  ok: boolean
  /** The contract's rejection reason, when it rejected and named one. */
  reason: string | null
  /** The leader's rendered return value, when the call returned one. */
  returned: string | null
}

/**
 * What the network decided actually happened, read from the leader's receipt.
 *
 * The outcome lives in `consensus_data.leader_receipt`, not at the top level.
 * Studio receipts carry `execution_result` there as `SUCCESS` or `ERROR`, beside
 * a `result` of `{ status: 'return', payload: { readable } }` when the call
 * returned and `{ status: 'contract_error', payload: '<reason>' }` when it did
 * not. The typed top-level `txExecutionResultName` this used to test is left
 * undefined on this network, so a check against it silently passed everything -
 * which is the same mistake in a new place, since a rejected write would then
 * have been reported to the visitor as a success.
 *
 * Both spellings of the enum are accepted because the SDK's own type
 * (`FINISHED_WITH_RETURN` / `FINISHED_WITH_ERROR`) is what other networks return,
 * and a receipt that carries neither is treated as a success only if nothing
 * else contradicts it - the node has to say a call failed for this to raise, and
 * an unrecognised shape must not invent a failure that did not happen.
 */
export function outcomeOf(receipt: GenLayerTransaction): Outcome {
  const entries = receipt.consensus_data?.leader_receipt
  const list = Array.isArray(entries) ? entries : []

  // By `mode`, not by position. The array can carry more than one entry when a
  // round rotates, and the leader is whichever entry says it is - reading
  // `[0]` happened to be right on every receipt observed but is an assumption
  // about ordering that nothing documents. Falling back to the first entry
  // keeps the previous behaviour for a node that omits `mode` rather than
  // treating a missing field as a failure.
  const leader =
    list.find((entry) => (entry as { mode?: unknown })?.mode === 'leader') ?? list[0]

  const executed = (leader as { execution_result?: unknown })?.execution_result
  const result = (leader as { result?: unknown })?.result
  const status = (result as { status?: unknown })?.status
  const payload = (result as { payload?: unknown })?.payload

  const failed =
    executed === 'ERROR' ||
    executed === 'FINISHED_WITH_ERROR' ||
    receipt.txExecutionResultName === 'FINISHED_WITH_ERROR' ||
    (typeof status === 'string' && status !== 'return')

  const readable = (payload as { readable?: unknown })?.readable
  const message = (payload as { message?: unknown })?.message

  return {
    ok: !failed,
    reason:
      typeof payload === 'string' && payload.length > 0
        ? payload
        : typeof message === 'string' && message.length > 0
          ? message
          : typeof status === 'string' && status !== 'return'
            ? status
            : null,
    returned: typeof readable === 'string' ? readable : null,
  }
}
