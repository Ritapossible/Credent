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
        {/* The site's primary call to action, so it wears the primary button -
            at the shared control height rather than `btn--sm`'s 36px, which left
            it visibly short of the two icon buttons beside it. */}
        <button
          type="button"
          className="btn wallet-pill wallet-pill--connect"
          onClick={openPicker}
          disabled={connecting}
        >
          {connecting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Connecting…
            </>
          ) : (
            <>
              {/* Two labels, one shown at a time. On a phone the full phrase is
                  a third of the masthead row; swapping it in CSS keeps the
                  control on that row instead of in the menu. */}
              <span className="wallet-pill__full">Connect wallet</span>
              <span className="wallet-pill__short">Connect</span>
            </>
          )}
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
          className="wallet-pill wallet-pill--warn"
          onClick={() => void connect()}
          title={`Your wallet is on another network. This build reads ${NETWORK}.`}
        >
          <WarnIcon />
          <span className="wallet-pill__full">Switch to {NETWORK}</span>
          <span className="wallet-pill__short">Switch</span>
        </button>
      </div>
    )
  }

  return (
    <div className="wallet-control" ref={wrap}>
      <button
        type="button"
        className="wallet-pill wallet-pill--connected"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title={address}
      >
        {active ? (
          <img className="wallet-pill__icon" src={active.icon} alt="" aria-hidden />
        ) : (
          <span className="wallet-pill__dot" aria-hidden="true" />
        )}
        {/* Hidden on a phone, where the pill collapses to the wallet's mark. The
            full address is a tap away in the menu below. */}
        <span className="mono wallet-pill__addr">{shortAddress(address)}</span>
        <svg
          className="wallet-pill__caret"
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

/** Marks the wrong-network pill as a warning rather than a second CTA. */
function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M12 4.5l8 14.5H4l8-14.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="16.6" r="1" fill="currentColor" />
    </svg>
  )
}
