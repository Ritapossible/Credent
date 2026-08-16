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
  hasWallet,
  onExpectedChain,
  watchWallet,
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
  connect: () => Promise<void>
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

  const available = hasWallet()

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

  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      setAddress(await connectWallet())
      setRightChain(await onExpectedChain())
    } catch (cause) {
      if (!isUserRejection(cause)) setError(readableError(cause))
    } finally {
      setConnecting(false)
    }
  }, [])

  // No `disconnect`. There was one, exposed on the context and called by
  // nothing: wallets have no disconnect a site can invoke, so it only ever
  // cleared this component's copy of an address the wallet still considers
  // authorised, and the next `accountsChanged` or reload would bring it back.
  // A control that appears to revoke access without revoking it is worse than
  // its absence.
  const value = useMemo(
    () => ({ address, available, rightChain, connecting, error, connect }),
    [address, available, rightChain, connecting, error, connect],
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
