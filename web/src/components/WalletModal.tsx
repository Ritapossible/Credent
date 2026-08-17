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
import { createPortal } from 'react-dom'

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

/** Everything inside the panel that a Tab press should be able to reach. */
const FOCUSABLE = 'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export default function WalletModal({ wallets, connecting, error, onPick, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  /**
   * Which row was pressed. The context reports one global `connecting` flag, so
   * without this every row in the list said "Waiting…" at once and it was not
   * possible to tell which wallet the browser was actually asking about.
   */
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!connecting) setPending(null)
  }, [connecting])

  /**
   * `onClose` arrives as a fresh closure on every render, and the effect below
   * must not re-run: it moves focus, so a re-render would yank the caret back to
   * the first row mid-interaction and hand focus to whatever happened to hold it
   * when that render started. A ref keeps the handler current with a mount-only
   * effect.
   */
  const close = useRef(onClose)
  close.current = onClose

  /**
   * Escape closes, focus moves in on open and back out on close, and Tab is
   * held inside the panel.
   *
   * The trap is not decoration: this is `aria-modal`, so a screen reader is
   * already being told the rest of the page is unavailable, and letting Tab walk
   * out into a masthead it cannot see makes that a lie.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current()
        return
      }
      if (event.key !== 'Tab') return

      const stops = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (stops.length === 0) return

      const first = stops[0]
      const last = stops[stops.length - 1]
      const on = document.activeElement

      // Wrap at both ends, and pull focus back in if it had already escaped -
      // which it has on the first Tab after the dialog opens over a page whose
      // focus was somewhere else entirely.
      if (!event.shiftKey && (on === last || !panel.current?.contains(on))) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (on === first || !panel.current?.contains(on))) {
        event.preventDefault()
        last.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      // Back to the control that opened it, so a keyboard visitor resumes where
      // they left off instead of at the top of the document.
      opener?.focus?.()
    }
  }, [])

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

  /**
   * Rendered into `<body>`, not where it is written.
   *
   * The masthead carries `backdrop-filter`, which makes it a containing block
   * for fixed-position descendants. The dialog is `position: fixed; inset: 0`,
   * so mounted inside the masthead it was sized to the masthead: a backdrop
   * covering only the header strip and a panel crushed into it. A portal is what
   * gets `inset: 0` measured against the viewport again.
   */
  return createPortal(
    <div
      className="wallet-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
      aria-describedby="wallet-modal-lede"
      // Only a press that lands on the backdrop itself closes. Testing the
      // target beats stopping propagation inside the panel: a press that starts
      // on a row and drifts off it no longer dismisses the dialog.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="wallet-modal__panel" ref={panel}>
        <div className="wallet-modal__head">
          <div>
            <h2 id="wallet-modal-title" className="wallet-modal__title">
              {empty ? 'Get a wallet' : 'Connect a wallet'}
            </h2>
            <p id="wallet-modal-lede" className="wallet-modal__lede">
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
                    onClick={() => {
                      setPending(wallet.rdns)
                      onPick(wallet.rdns)
                    }}
                    disabled={connecting}
                    // The reverse-DNS id used to be printed under the name. It
                    // is the right tiebreaker between two wallets calling
                    // themselves the same thing and the wrong thing to show
                    // everyone else, so it lives here instead.
                    title={wallet.rdns}
                  >
                    <img className="wallet-option__icon" src={wallet.icon} alt="" aria-hidden />
                    <span className="wallet-option__name">{wallet.name}</span>
                    {pending === wallet.rdns ? (
                      <span className="wallet-option__action">
                        <span className="spinner" aria-hidden="true" />
                        Waiting…
                      </span>
                    ) : (
                      <span className="wallet-option__badge">Installed</span>
                    )}
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
    </div>,
    document.body,
  )
}
