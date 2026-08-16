/**
 * The connect control in the masthead.
 *
 * Deliberately the only place in the chrome that mentions a wallet. Reading the
 * site needs no connection at all - every page renders from view calls - so this
 * stays quiet until someone wants to write, and never blocks a page behind it.
 */

import { useWallet } from '../chain/useWallet'
import { shortAddress } from '../core/format'
import { NETWORK } from '../chain/config'

export default function ConnectButton() {
  const { address, available, rightChain, connecting, connect } = useWallet()

  if (!available) {
    return (
      <a
        className="btn btn--ghost btn--sm wallet-button"
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer noopener"
        title="A browser wallet is needed to post to the chain. Reading needs nothing."
      >
        Get a wallet
      </a>
    )
  }

  if (address === null) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm wallet-button"
        onClick={() => void connect()}
        disabled={connecting}
      >
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }

  // Connected but pointed elsewhere. `connect()` runs the switch, so the button
  // stays the way out of the state rather than becoming a dead label.
  if (rightChain === false) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm wallet-button wallet-button--warn"
        onClick={() => void connect()}
        title={`Your wallet is on another network. This build reads ${NETWORK}.`}
      >
        Switch to {NETWORK}
      </button>
    )
  }

  return (
    <span className="wallet-button wallet-button--connected" title={address}>
      <span className="wallet-button__dot" aria-hidden="true" />
      <span className="mono">{shortAddress(address)}</span>
    </span>
  )
}
