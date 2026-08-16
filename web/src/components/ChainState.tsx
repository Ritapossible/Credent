/**
 * The three states every chain-backed page has to render besides its data.
 *
 * Kept in one component because they are easy to get subtly wrong per page: an
 * unconfigured build and a failed read look identical to a visitor if both are
 * rendered as "something went wrong", and they need opposite responses - one is
 * a deploy step nobody ran, the other is a network that is down.
 */

import type { ReactNode } from 'react'

import { CONFIG_ERROR, CONTRACT_ADDRESS, NETWORK } from '../chain/config'
import type { Async } from '../chain/useOracle'

interface Props<T> {
  state: Async<T>
  /** What this page was reading, for the failure message: "the registry". */
  what: string
  children: (data: T) => ReactNode
}

export default function ChainState<T>({ state, what, children }: Props<T>) {
  // Ahead of `unconfigured`, which would otherwise report a missing address for
  // a build that has one and cannot be trusted to point it anywhere.
  if (CONFIG_ERROR !== null) {
    return (
      <div className="notice notice--critical">
        <h3 className="notice__title">Misconfigured network</h3>
        <p>{CONFIG_ERROR}</p>
        <p className="muted">
          Nothing is read until this is corrected, because the address in this build belongs to a
          different network than the one requested.
        </p>
      </div>
    )
  }

  if (state.unconfigured) {
    return (
      <div className="notice">
        <h3 className="notice__title">No contract configured</h3>
        <p>
          This build has no <code className="mono">VITE_CONTRACT_ADDRESS</code>, so there is no
          deployment to read {what} from. Deploy the oracle and rebuild with the address it
          returned.
        </p>
      </div>
    )
  }

  if (state.loading) {
    return (
      <p className="empty muted" role="status" aria-live="polite">
        Reading {what} from {NETWORK}…
      </p>
    )
  }

  if (state.error !== null) {
    return (
      <div className="notice notice--critical">
        <h3 className="notice__title">Could not read {what}</h3>
        <p>{state.error}</p>
        <p className="muted">
          Reading <code className="mono">{CONTRACT_ADDRESS || '(unset)'}</code> on {NETWORK}.
        </p>
      </div>
    )
  }

  if (state.data === null) return null

  return <>{children(state.data)}</>
}
