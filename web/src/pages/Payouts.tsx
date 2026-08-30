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
 *   withdraw    emits the value to `gl.message.sender_address`. It delivers
 *               only when the caller is a contract that can receive, and the
 *               contract cannot check that -- so a wallet calling it is betting
 *               real money on an assertion about itself. The card says so.
 *
 * `reclaim_in_flight` is the recovery path. `withdraw` cannot observe whether
 * its transfer arrived, so it parks the entitlement in `in_flight` rather than
 * discarding it; reclaim restores it when the contract still holds the money,
 * and refuses when it does not. That refusal is correct: value that has left
 * cannot be recovered by rewriting a ledger, and restoring the entitlement
 * anyway would pay one owner out of the balance backing everyone else's.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { CONTRACT_ADDRESS, EXPLORER_URL, IS_CONFIGURED, NETWORK } from '../chain/config'
import { inFlightTo, owedTo, solvency, type Solvency } from '../chain/oracle'
import { useWallet } from '../chain/useWallet'
import { assignTo, reclaimInFlight, withdraw, type WriteResult } from '../chain/wallet'
import { useWalletPicker } from '../components/WalletModal'
import { formatBond, shortAddress } from '../core/format'
import { normalizeAddress } from '../core/digest'
import { readableError } from '../core/errors'

type Balances = { owed: bigint; inFlight: bigint; solvency: Solvency }

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
      const [owed, inFlight, health] = await Promise.all([
        owedTo(address),
        inFlightTo(address),
        solvency(),
      ])
      setBalances({ owed, inFlight, solvency: health })
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

  const recipientValid = recipient.trim() === '' ? null : normalizeAddress(recipient.trim()) !== null

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
                    <dt>In flight</dt>
                    <dd>{formatBond(balances.inFlight)}</dd>
                  </div>
                  <div>
                    <dt>Contract holds</dt>
                    <dd>{formatBond(balances.solvency.balance)}</dd>
                  </div>
                </dl>
                {balances.inFlight > 0n && (
                  <p className="notice">
                    A withdrawal of {formatBond(balances.inFlight)} was emitted and this contract
                    cannot see whether it arrived.{' '}
                    {balances.solvency.backed
                      ? 'The money is still here, so reclaiming it will restore the entitlement.'
                      : 'The value has already left the contract, so reclaiming will be refused — restoring it would pay you out of the balance backing everyone else.'}
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
              Emits the value to the caller. It arrives only if the caller is a{' '}
              <strong>contract</strong> that can receive — <code>emit_transfer</code> does not credit
              an ordinary account, and a transfer that cannot be delivered is not returned. If you
              are connected with a wallet, assign instead.
            </p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy !== null || balances === null || balances.owed === 0n}
              onClick={() => void run('withdraw', () => withdraw(address))}
            >
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw (contracts only)'}
            </button>
          </section>

          {balances !== null && balances.inFlight > 0n && (
            <section className="card">
              <h2 className="card__title">Reclaim an unconfirmed withdrawal</h2>
              <p className="muted">
                Restores {formatBond(balances.inFlight)} to your balance, if the contract still
                holds it. Refused otherwise, on purpose.
              </p>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void run('reclaim', () => reclaimInFlight(address))}
              >
                {busy === 'reclaim' ? 'Reclaiming…' : 'Reclaim'}
              </button>
            </section>
          )}

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
