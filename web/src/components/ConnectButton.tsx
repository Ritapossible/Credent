/**
 * The wallet control in the primary nav.
 *
 * Deliberately the only place in the chrome that mentions a wallet. Reading the
 * site needs no connection at all - every page renders from view calls - so this
 * stays quiet until someone wants to write, and never blocks a page behind it.
 *
 * It lives inside the nav rather than beside the brand. On a phone the masthead
 * row was carrying a wordmark, a wallet control, a menu button and a theme
 * toggle, and the wallet control is the one of the four that is not needed to
 * read anything - so it collapses into the menu with the destinations while the
 * other three stay reachable.
 */

import { useEffect, useRef, useState } from 'react'

import { useWalletPicker } from './WalletModal'
import { useWallet } from '../chain/useWallet'
import { shortAddress } from '../core/format'
import { EXPLORER_URL, NETWORK } from '../chain/config'

export default function ConnectButton() {
  const { address, rightChain, connecting, connect, disconnect, active } = useWallet()
  const { openPicker, picker } = useWalletPicker()
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Close the account menu on an outside press or Escape. Without the first,
  // the menu survives navigation clicks behind it and hangs over the next page.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const copy = async () => {
    if (address === null) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard permission refused. The address is on screen to be read.
    }
  }

  if (address === null) {
    return (
      <div className="wallet-control" ref={wrap}>
        <button
          type="button"
          className="btn btn--sm wallet-button wallet-button--connect"
          onClick={openPicker}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        {picker}
      </div>
    )
  }

  // Connected but pointed elsewhere. `connect()` runs the switch, so the button
  // stays the way out of the state rather than becoming a dead label.
  if (rightChain === false) {
    return (
      <div className="wallet-control" ref={wrap}>
        <button
          type="button"
          className="btn btn--sm wallet-button wallet-button--warn"
          onClick={() => void connect()}
          title={`Your wallet is on another network. This build reads ${NETWORK}.`}
        >
          Switch to {NETWORK}
        </button>
      </div>
    )
  }

  return (
    <div className="wallet-control" ref={wrap}>
      <button
        type="button"
        className="wallet-button wallet-button--connected"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title={address}
      >
        {active ? (
          <img className="wallet-button__icon" src={active.icon} alt="" aria-hidden />
        ) : (
          <span className="wallet-button__dot" aria-hidden="true" />
        )}
        <span className="mono">{shortAddress(address)}</span>
        <svg
          className="wallet-button__caret"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" />
        </svg>
      </button>

      {menuOpen ? (
        <div className="wallet-menu" role="menu">
          <div className="wallet-menu__head">
            <span className="wallet-menu__label">
              {active ? active.name : 'Connected'} · {NETWORK}
            </span>
            <span className="wallet-menu__address mono">{address}</span>
          </div>

          <button type="button" className="wallet-menu__item" role="menuitem" onClick={copy}>
            {copied ? 'Copied' : 'Copy address'}
          </button>

          {EXPLORER_URL ? (
            <a
              className="wallet-menu__item"
              role="menuitem"
              href={`${EXPLORER_URL}/address/${address}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              View on explorer →
            </a>
          ) : null}

          <button
            type="button"
            className="wallet-menu__item wallet-menu__item--danger"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              void disconnect()
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  )
}
