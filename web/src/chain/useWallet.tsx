/**
 * React binding for the write client.
 *
 * A context rather than a hook per component, because the connection is one
 * piece of state with two readers - the masthead button and whatever page is
 * currently offering to write - and two independent copies would disagree the
 * moment the visitor switched accounts in their wallet.
 *
 * It holds no key and starts no prompt on its own. On mount it asks
 * `eth_accounts`, which reports an authorisation the visitor has already given
 * and shows no dialog; the wallet only opens when someone presses Connect.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { readableError } from '../core/errors'
import {
  connectWallet,
  currentAccount,
  disconnectWallet,
  discoverWallets,
  hasWallet,
  listWallets,
  onExpectedChain,
  selectedWallet,
  watchForWallet,
  watchWallet,
  type WalletInfo,
} from './wallet'

export interface WalletState {
  /** The connected address, lowercased, or null when not connected. */
  address: string | null
  /** False when no injected wallet exists at all - the install case. */
  available: boolean
  /**
   * Whether the wallet is pointed at the network this build reads from. Null
   * until known. A connected wallet on the wrong chain can still sign, and the
   * transaction would go somewhere this contract does not exist, so the write
   * surfaces refuse rather than send.
   */
  rightChain: boolean | null
  connecting: boolean
  error: string | null
  /**
   * Connect, optionally naming which announced wallet to use. Called without an
   * argument it uses the remembered choice, or the only wallet installed.
   */
  connect: (rdns?: string) => Promise<void>
  /** Revoke where the wallet allows it, and stop reconnecting either way. */
  disconnect: () => Promise<void>
  /** Every wallet that announced itself, for the picker. Empty on a plain page. */
  wallets: WalletInfo[]
  /** Which of them is in use, once one has been chosen. */
  active: WalletInfo | null
}

const WalletContext = createContext<WalletState | null>(null)

/**
 * User rejections are not errors worth reporting.
 *
 * 4001 is EIP-1193's "the user rejected the request". Someone who closed the
 * MetaMask dialog knows what they did, and a red banner telling them so reads as
 * a malfunction.
 */
function isUserRejection(cause: unknown): boolean {
  return (cause as { code?: number })?.code === 4001
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [rightChain, setRightChain] = useState<boolean | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [wallets, setWallets] = useState<WalletInfo[]>(listWallets)
  const [active, setActive] = useState<WalletInfo | null>(selectedWallet)

  // State, not a bare `hasWallet()` call. An extension that injects after this
  // first renders would otherwise never be noticed - see `watchForWallet`.
  const [available, setAvailable] = useState(hasWallet)

  // EIP-6963 discovery. This is what lets the picker name the wallets a visitor
  // actually has rather than guessing, and what makes a page with MetaMask and
  // Rabby side by side resolvable at all - both would otherwise be fighting
  // over the single `window.ethereum` slot.
  useEffect(
    () =>
      discoverWallets((found) => {
        setWallets(found)
        setActive(selectedWallet())
        if (found.length > 0) setAvailable(true)
      }),
    [],
  )

  useEffect(() => {
    if (available) return
    return watchForWallet(() => setAvailable(true))
  }, [available])

  // Pick up an authorisation from a previous visit, and keep up with the wallet
  // afterwards. `live` guards the async settle against an unmount, which is the
  // ordinary case under StrictMode's double-invoked effects.
  useEffect(() => {
    if (!available) return
    let live = true

    void currentAccount().then((found) => {
      if (live && found) setAddress(found)
    })
    void onExpectedChain().then((ok) => {
      if (live) setRightChain(ok)
    })

    const unwatch = watchWallet({
      onAccounts: (next) => {
        if (!live) return
        setAddress(next)
        // Locking the wallet clears the account; that is not a failure to show.
        setError(null)
      },
      onChain: () => {
        if (!live) return
        void onExpectedChain().then((ok) => {
          if (live) setRightChain(ok)
        })
      },
    })

    // Both halves. Returning `unwatch` alone left `live` true forever, so every
    // guard above was decoration and the comment describing them was wrong.
    return () => {
      live = false
      unwatch()
    }
  }, [available])

  const connect = useCallback(async (rdns?: string) => {
    setConnecting(true)
    setError(null)
    try {
      setAddress(await connectWallet(rdns))
      setActive(selectedWallet())
      setRightChain(await onExpectedChain())
    } catch (cause) {
      if (!isUserRejection(cause)) setError(readableError(cause))
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    // Cleared first. The revocation request can be slow or refused, and the
    // control has to read as having worked the moment it is pressed.
    setAddress(null)
    setActive(null)
    setError(null)
    await disconnectWallet()
  }, [])

  // There used to be no `disconnect` here, and the note in its place explained
  // why: the one that had been removed only cleared this component's copy of an
  // address the wallet still considered authorised, so the next reload brought
  // it back. That objection was right about the implementation and is answered
  // rather than ignored by the one in `wallet.ts` - it asks the wallet to revoke
  // through EIP-2255 and records the intent locally so a wallet that will not
  // revoke still cannot reconnect the visitor behind their back.
  const value = useMemo(
    () => ({
      address,
      available,
      rightChain,
      connecting,
      error,
      connect,
      disconnect,
      wallets,
      active,
    }),
    [address, available, rightChain, connecting, error, connect, disconnect, wallets, active],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const state = useContext(WalletContext)
  if (state === null) {
    throw new Error('useWallet must be used inside a <WalletProvider>')
  }
  return state
}
