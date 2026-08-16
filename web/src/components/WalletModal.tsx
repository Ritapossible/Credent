/**
 * The wallet picker.
 *
 * A browser with more than one wallet installed cannot be resolved by reading
 * `window.ethereum` - they overwrite each other for it, and whichever loaded
 * last wins regardless of which one the visitor meant. EIP-6963 exists for
 * exactly that, and this is its user-facing half: every wallet that announced
 * itself is listed by its own name and icon, and pressing one names it.
 *
 * The empty state is the install case, and it is a list rather than a single
 * MetaMask link because naming one wallet as *the* wallet is both wrong and the
 * sort of thing that quietly becomes a recommendation.
 */

import { useEffect, useRef, useState } from 'react'

import { useWallet } from '../chain/useWallet'
import type { WalletInfo } from '../chain/wallet'

/**
 * Where to get a wallet, when none is installed.
 *
 * No logos: the icons in the connected case arrive as `data:` URIs from the
 * wallets themselves, which the site's CSP allows, while bundling third-party
 * marks here would mean either remote images the CSP blocks or copies of
 * trademarks this repo has no licence to ship.
 */
const INSTALL = [
  { name: 'MetaMask', href: 'https://metamask.io/download/', note: 'The most widely supported' },
  { name: 'Rabby', href: 'https://rabby.io/', note: 'Built for multiple chains' },
  { name: 'OKX Wallet', href: 'https://www.okx.com/web3', note: 'Extension and mobile' },
]

/**
 * The picker, wired to the wallet context, for anywhere that offers to connect.
 *
 * Shared so the masthead control and the gate on the write page cannot drift
 * into offering different things. The button that used to sit on that page
 * called `connect()` with no argument, which is only unambiguous while exactly
 * one wallet is installed - the case this whole component exists to stop
 * assuming.
 */
export function useWalletPicker() {
  const { wallets, connecting, error, connect, address } = useWallet()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (address !== null) setOpen(false)
  }, [address])

  return {
    openPicker: () => setOpen(true),
    picker: open ? (
      <WalletModal
        wallets={wallets}
        connecting={connecting}
        error={error}
        onPick={(rdns) => void connect(rdns)}
        onClose={() => setOpen(false)}
      />
    ) : null,
  }
}

interface Props {
  wallets: WalletInfo[]
  connecting: boolean
  error: string | null
  onPick: (rdns: string) => void
  onClose: () => void
}

export default function WalletModal({ wallets, connecting, error, onPick, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)

  // Escape closes, and focus moves into the dialog so the first press of Tab
  // lands inside it rather than back on the page behind.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('button, a')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The page behind must not scroll under the dialog on a phone, where the
  // dialog is a sheet and the page would otherwise slide around beneath it.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const empty = wallets.length === 0

  return (
    <div
      className="wallet-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
      onClick={onClose}
    >
      {/* Stops a press inside the panel from reaching the backdrop's close. */}
      <div className="wallet-modal__panel" ref={panel} onClick={(e) => e.stopPropagation()}>
        <div className="wallet-modal__head">
          <div>
            <h2 id="wallet-modal-title" className="wallet-modal__title">
              {empty ? 'Get a wallet' : 'Connect a wallet'}
            </h2>
            <p className="wallet-modal__lede">
              {empty
                ? 'Reading the registry needs no wallet. One is only required to post.'
                : 'Used to sign what you post. Credent never holds a key.'}
            </p>
          </div>
          <button
            type="button"
            className="wallet-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {error !== null ? (
          <p className="form-status form-status--error wallet-modal__error">{error}</p>
        ) : null}

        <ul className="wallet-list">
          {empty
            ? INSTALL.map((item) => (
                <li key={item.name}>
                  <a
                    className="wallet-option"
                    href={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span className="wallet-option__glyph" aria-hidden="true">
                      {item.name.slice(0, 1)}
                    </span>
                    <span className="wallet-option__text">
                      <span className="wallet-option__name">{item.name}</span>
                      <span className="wallet-option__note">{item.note}</span>
                    </span>
                    <span className="wallet-option__action">Install →</span>
                  </a>
                </li>
              ))
            : wallets.map((wallet) => (
                <li key={wallet.rdns}>
                  <button
                    type="button"
                    className="wallet-option"
                    onClick={() => onPick(wallet.rdns)}
                    disabled={connecting}
                  >
                    <img className="wallet-option__icon" src={wallet.icon} alt="" aria-hidden />
                    <span className="wallet-option__text">
                      <span className="wallet-option__name">{wallet.name}</span>
                      <span className="wallet-option__note mono">{wallet.rdns}</span>
                    </span>
                    <span className="wallet-option__action">
                      {connecting ? 'Waiting…' : 'Connect'}
                    </span>
                  </button>
                </li>
              ))}
        </ul>

        <p className="wallet-modal__foot muted">
          {empty
            ? 'Install one, then reload this page.'
            : 'Approving only shares your address. Every transaction is confirmed separately.'}
        </p>
      </div>
    </div>
  )
}
