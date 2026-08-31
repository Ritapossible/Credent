/**
 * The payout surface: what the contract owes you, and how to get it out.
 *
 * Settlement here credits an entitlement rather than pushing value, because
 * `emit_transfer` does not credit an externally owned account. Every payout in
 * the protocol -- released collateral, claimed collateral, a reclaimed bond, a
 * refunded overpayment -- therefore lands in `owed_to(you)` and stays there
 * until something moves it. This page is that something, and until it existed
 * the site could open engagements, grade them and settle them without ever
 * showing a visitor the money.
 *
 * Two ways out, and the difference is not cosmetic:
 *
 *   assign_to   rewrites two storage slots. No value moves, so nothing can be
 *               lost, and a recipient that turns out to be unable to collect
 *               leaves the entitlement sitting there to reassign. This is the
 *               path for a wallet.
 *
 *   withdraw    emits the value to `gl.message.sender_address`, and is refused
 *               unless that address has completed the probe handshake --
 *               `prove_recipient`, then `confirm_recipient` from inside the
 *               callback. Answering the probe means having executed code, so
 *               the ordinary recipient is verified rather than asserted.
 *
 * The handshake is a bar, not a proof of contract-hood, and this page does not
 * sell it as one: a wallet can drive both calls itself, in two deliberate
 * transactions, and no contract on this platform can tell the difference. What
 * it removes is the single wrong flag on the payout call that the previous
 * `withdraw(recipient_is_a_contract)` allowed. `assign_to` carries no claim at
 * all, which is why the button above is the default and this one is not.
 *
 * There is no recovery path, deliberately. `emit_transfer` does not refund what
 * it fails to deliver and delivery is not observable from inside the contract,
 * so a "reclaim" method could only guess -- two earlier designs guessed from
 * the balance and from a ledger, and both were wrong. Refusing to emit at an
 * unverified address is the honest version of the same guarantee.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { CONTRACT_ADDRESS, EXPLORER_URL, IS_CONFIGURED, NETWORK } from '../chain/config'
import { isProven, liabilities, owedTo, type Liabilities } from '../chain/oracle'
import { useWallet } from '../chain/useWallet'
import { assignTo, withdraw, type WriteResult } from '../chain/wallet'
import { useWalletPicker } from '../components/WalletModal'
import { formatBond, shortAddress } from '../core/format'
import { isAddress } from '../core/address'
import { readableError } from '../core/errors'

type Balances = { owed: bigint; proven: boolean; liabilities: Liabilities }

export default function Payouts() {
  const { address, connecting, rightChain } = useWallet()
  const { openPicker, picker } = useWalletPicker()

  const [balances, setBalances] = useState<Balances | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<WriteResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')

  const refresh = useCallback(async () => {
    if (!IS_CONFIGURED || address === null) {
      setBalances(null)
      return
    }
    try {
      // Read together: an owed figure without its in-flight companion invites
      // the reading that a zero balance means nothing is due, when it can mean
      // a payout is out and unconfirmed.
      const [owed, proven, totals] = await Promise.all([
        owedTo(address),
        isProven(address),
        liabilities(),
      ])
      setBalances({ owed, proven, liabilities: totals })
      setLoadError(null)
    } catch (err) {
      setLoadError(readableError(err))
    }
  }, [address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (label: string, fn: () => Promise<WriteResult>) => {
      setBusy(label)
      setActionError(null)
      setResult(null)
      try {
        setResult(await fn())
        await refresh()
      } catch (err) {
        setActionError(readableError(err))
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  if (!IS_CONFIGURED) {
    return (
      <div className="notice notice--critical">
        <h1 className="notice__title">No contract configured</h1>
        <p>
          Set <code>VITE_CONTRACT_ADDRESS</code> to a deployed ReputationOracle and rebuild. The
          address is inlined at build time, so changing it in a hosting dashboard does not affect a
          build that has already shipped.
        </p>
      </div>
    )
  }

  const recipientValid = recipient.trim() === '' ? null : isAddress(recipient)

  return (
    <div className="page">
      <div className="section-head">
        <h1>Payouts</h1>
        <p className="muted">
          Settlement credits what you are owed; it never pushes value at you. This is where the
          credit becomes money. Reading is free and needs no wallet; moving it is signed by you.
        </p>
      </div>

      {address === null ? (
        <div className="notice">
          <h2 className="notice__title">Connect to see what you are owed</h2>
          <p>
            <code>owed_to</code> is keyed by address, so there is nothing to show until one is
            connected. The site holds no key and signs nothing.
          </p>
          <button type="button" className="btn" onClick={openPicker} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
          {picker}
        </div>
      ) : rightChain === false ? (
        <div className="notice notice--critical">
          <h2 className="notice__title">Wrong network</h2>
          <p>
            Your wallet is on another network. This contract lives on <strong>{NETWORK}</strong> at{' '}
            <code>{shortAddress(CONTRACT_ADDRESS)}</code>.
          </p>
        </div>
      ) : (
        <>
          <section className="card">
            <h2 className="card__title">Your balance</h2>
            {loadError !== null ? (
              <p className="notice notice--critical">{loadError}</p>
            ) : balances === null ? (
              <p className="muted">Reading…</p>
            ) : (
              <>
                <dl className="stats">
                  <div>
                    <dt>Owed to you</dt>
                    <dd>{formatBond(balances.owed)}</dd>
                  </div>
                  <div>
                    <dt>Can receive</dt>
                    <dd>{balances.proven ? 'proven' : 'not proven'}</dd>
                  </div>
                  <div>
                    <dt>Contract owes in total</dt>
                    <dd>{formatBond(balances.liabilities.totalOwed)}</dd>
                  </div>
                </dl>
                {!balances.proven && balances.owed > 0n && (
                  <p className="notice">
                    This address has not proven it can receive value, so withdrawing is refused
                    rather than attempted. That is deliberate: a transfer to an address that
                    cannot receive is not returned. Assign the entitlement to a contract instead.
                  </p>
                )}
                <button type="button" className="btn btn--ghost" onClick={() => void refresh()}>
                  Refresh
                </button>
              </>
            )}
          </section>

          <section className="card">
            <h2 className="card__title">Assign it to a contract</h2>
            <p className="muted">
              Moves the entitlement, not the money. Nothing leaves this contract, so nothing can be
              lost on the way — if the recipient turns out to be unable to collect, the credit is
              still there under its address. This is the path to use unless you are a contract.
            </p>
            <label className="field">
              <span className="field__label">Recipient address</span>
              <input
                className="field__input"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
            </label>
            {recipientValid === false && <p className="field__error">That is not an address.</p>}
            <button
              type="button"
              className="btn"
              disabled={
                busy !== null ||
                recipientValid !== true ||
                balances === null ||
                balances.owed === 0n
              }
              onClick={() => void run('assign', () => assignTo(address, recipient.trim()))}
            >
              {busy === 'assign' ? 'Assigning…' : 'Assign entitlement'}
            </button>
          </section>

          <section className="card">
            <h2 className="card__title">Withdraw to yourself</h2>
            <p className="muted">
              Emits the value to the caller, and is refused unless this address has answered the
              contract&rsquo;s zero-value probe. Answering it from a browser wallet means signing two
              deliberate transactions and claiming something about yourself that the contract cannot
              check — so this button stays disabled here, and the safe path above is the one to use.
              It is offered because a contract driving this site&rsquo;s calls can answer the probe
              by running code, which is the case it is for.
            </p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={
                busy !== null ||
                balances === null ||
                balances.owed === 0n ||
                !balances.proven
              }
              onClick={() => void run('withdraw', () => withdraw(address))}
              title={
                balances !== null && !balances.proven
                  ? 'This address has not proven it can receive value'
                  : undefined
              }
            >
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </section>

          {actionError !== null && <p className="notice notice--critical">{actionError}</p>}
          {result !== null && (
            <p className="notice">
              Done.{' '}
              {EXPLORER_URL !== null ? (
                <a href={`${EXPLORER_URL}/tx/${result.hash}`} target="_blank" rel="noreferrer">
                  {shortAddress(result.hash)}
                </a>
              ) : (
                <code>{shortAddress(result.hash)}</code>
              )}
            </p>
          )}
        </>
      )}

      <p className="muted">
        Where these balances come from: <Link to="/attest">the engagement lifecycle</Link>.
      </p>
    </div>
  )
}
