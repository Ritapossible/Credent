/**
 * The write surface.
 *
 * Laid out as the engagement lifecycle rather than as a list of methods, because
 * the order is not optional: a scope has to be committed before the work, agreed
 * to by the party being graded, closed after it, and only then can either side
 * be graded on it. A page that offered the calls as equals would invite the
 * sequence errors the contract then rejects - `engagement_not_accepted`,
 * `engagement_not_closed`, `sender_not_counterparty` - one gas fee at a time.
 *
 * Every card writes with the visitor's own wallet. The site holds no key and
 * signs nothing; see `chain/wallet.ts`.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { CONTRACT_ADDRESS, EXPLORER_URL, IS_CONFIGURED, NETWORK } from '../chain/config'
import {
  bondForNext,
  collateralQuote,
  getEngagement,
  type CollateralQuote,
} from '../chain/oracle'
import { useWallet } from '../chain/useWallet'
import {
  acceptEngagement,
  attest,
  claimCollateral,
  closeEngagement,
  openEngagement,
  reclaimBond,
  releaseCollateral,
  type WriteResult,
} from '../chain/wallet'
import { useWalletPicker } from '../components/WalletModal'
import { bpToPercent, bpToScore, formatBond, parseTokens, shortAddress } from '../core/format'
import { normalizeAddress } from '../core/digest'
import { readableError } from '../core/errors'

// --- one pending write ----------------------------------------------------

interface ActionState {
  pending: boolean
  result: WriteResult | null
  error: string | null
}

const IDLE: ActionState = { pending: false, result: null, error: null }

/**
 * Runs one write and holds its outcome.
 *
 * Per action rather than one shared slot: a visitor who opens an engagement and
 * then closes it should still be able to see the first transaction's hash while
 * the second is in flight.
 */
function useAction() {
  const [state, setState] = useState<ActionState>(IDLE)

  const run = useCallback(async (write: () => Promise<WriteResult>) => {
    setState({ pending: true, result: null, error: null })
    try {
      setState({ pending: false, result: await write(), error: null })
    } catch (cause) {
      // 4001 is the visitor closing their own wallet dialog, not a failure.
      const rejected = (cause as { code?: number })?.code === 4001
      setState({ pending: false, result: null, error: rejected ? null : readableError(cause) })
    }
  }, [])

  return [state, run] as const
}

function Outcome({ state, verb }: { state: ActionState; verb: string }) {
  if (state.error !== null) {
    return <p className="form-status form-status--error">{state.error}</p>
  }
  if (state.result === null) return null

  return (
    <p className="form-status form-status--ok">
      {verb}
      {state.result.returned !== null && state.result.returned !== 'null' ? (
        <>
          {' '}
          Returned <strong className="mono">{state.result.returned}</strong>.
        </>
      ) : null}{' '}
      {EXPLORER_URL ? (
        <a
          href={`${EXPLORER_URL}/tx/${state.result.hash}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          View transaction →
        </a>
      ) : (
        <span className="mono">{state.result.hash}</span>
      )}
    </p>
  )
}

// --- page -----------------------------------------------------------------

export default function Attest() {
  const { address, available, rightChain, connecting, connect } = useWallet()

  const [openId, setOpenId] = useState('')
  const [openProvider, setOpenProvider] = useState('')
  const [openScope, setOpenScope] = useState('')
  const [openStake, setOpenStake] = useState('')
  const [openState, runOpen] = useAction()

  const [acceptId, setAcceptId] = useState('')
  const [acceptState, runAccept] = useAction()

  const [closeId, setCloseId] = useState('')
  const [closeState, runClose] = useAction()

  const [attestId, setAttestId] = useState('')
  const [claim, setClaim] = useState('')
  const [evidence, setEvidence] = useState('')
  const [attestState, runAttest] = useAction()

  const [reclaimId, setReclaimId] = useState('')
  const [reclaimState, runReclaim] = useAction()

  const [releaseId, setReleaseId] = useState('')
  const [releaseState, runRelease] = useAction()

  const [claimId, setClaimId] = useState('')
  const [claimState, runClaim] = useAction()

  // The stake is typed as GEN and sent as wei. `null` means the text is not an
  // amount this token can represent, which disables the button rather than
  // rounding it into one that is.
  const stake = parseTokens(openStake)

  // Read once here and passed down. Both the quoted cost and the button's
  // enabled state depend on it, and asking twice would be two chain reads per
  // keystroke in the engagement id.
  const { bond: attestBond, note: attestNote, blocked: attestBlocked } = useBond(attestId, address)

  // The collateral the connected wallet would have to post to accept, read from
  // the chain for the same reason the bond is: it is priced off this provider's
  // own score, so no constant is right for two agents.
  const { quote: acceptQuote, blocked: acceptBlocked } = useCollateral(acceptId, address)

  const canWrite = IS_CONFIGURED && address !== null && rightChain !== false

  if (!IS_CONFIGURED) {
    return (
      <div className="shell page">
        <div className="section-head">
          <p className="eyebrow eyebrow--pill">Post</p>
          <h1>Write to the registry</h1>
        </div>
        <div className="empty">
          <p>
            No contract address was configured for this build, so there is nothing to write to.
            Set <code>VITE_CONTRACT_ADDRESS</code> and rebuild.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Post</p>
        <h1>Write to the registry</h1>
        <p className="lede">
          Seven calls, in the order the protocol requires them. Two of them move money: accepting
          work posts collateral priced by your reputation, and attesting posts a bond. Each is
          signed by your own wallet - this site never holds a key.{' '}
          <Link to="/docs#protocol">How the lifecycle works →</Link>
        </p>
      </div>

      <WalletGate
        address={address}
        available={available}
        rightChain={rightChain}
        connecting={connecting}
        connect={connect}
      />

      <div className="lifecycle">
        <Step
          index={1}
          title="Open the engagement"
          blurb="Commits the scope digest before the outcome is known. You become the client; the address you name becomes the provider."
        >
          <div className="field">
            <label htmlFor="open-id">Engagement id</label>
            <input
              id="open-id"
              className="input mono"
              value={openId}
              placeholder="eng-001"
              onChange={(event) => setOpenId(event.target.value)}
            />
            <p className="hint">Any unique string. Reused ids are rejected.</p>
          </div>

          <div className="field">
            <label htmlFor="open-provider">Provider address</label>
            <input
              id="open-provider"
              className="input mono"
              value={openProvider}
              placeholder="0x…"
              onChange={(event) => setOpenProvider(event.target.value)}
            />
            <p className="hint">The counterparty. Cannot be you.</p>
          </div>

          <div className="field">
            <label htmlFor="open-stake">Value of the work (optional)</label>
            <input
              id="open-stake"
              className="input mono"
              value={openStake}
              placeholder="100"
              inputMode="decimal"
              onChange={(event) => setOpenStake(event.target.value)}
            />
            <p className={`hint${stake === null ? ' bond-note--blocked' : ''}`}>
              {stake === null
                ? 'Not an amount in GEN. Digits, with at most eighteen decimal places.'
                : 'In GEN. The provider posts collateral against this when they accept - more of it the worse their record. Leave it blank for an engagement with no collateral.'}
            </p>
          </div>

          <div className="field">
            <label htmlFor="open-scope">Scope</label>
            <textarea
              id="open-scope"
              className="textarea"
              value={openScope}
              placeholder="Specific enough to grade against."
              onChange={(event) => setOpenScope(event.target.value)}
            />
            <p className="hint">
              Hashed on commit. <Link to="/scope">Preview the digest →</Link>
            </p>
          </div>

          <button
            type="button"
            className="btn"
            disabled={
              !canWrite ||
              openState.pending ||
              !openId ||
              !openProvider ||
              !openScope.trim() ||
              stake === null
            }
            onClick={() =>
              void runOpen(() =>
                openEngagement(address as string, {
                  engagementId: openId,
                  provider: normalizeAddress(openProvider),
                  scope: openScope,
                  stake: stake ?? 0n,
                }),
              )
            }
          >
            {openState.pending ? 'Opening…' : 'Open engagement'}
          </button>
          <Outcome state={openState} verb="Engagement opened." />
        </Step>

        <Step
          index={2}
          title="Accept it, posting collateral"
          blurb="The provider agrees to be graded on that scope and puts up collateral against the work. Only they can accept, and what it costs them is decided by their own score."
        >
          <div className="field">
            <label htmlFor="accept-id">Engagement id</label>
            <input
              id="accept-id"
              className="input mono"
              value={acceptId}
              placeholder="eng-001"
              onChange={(event) => setAcceptId(event.target.value)}
            />
            <p className="hint">
              You must be the named provider. This is what stops anyone naming you as a
              counterparty and grading you on work you never agreed to.
            </p>
          </div>

          <CollateralNote quote={acceptQuote} blocked={acceptBlocked} />

          <button
            type="button"
            className="btn"
            disabled={!canWrite || acceptState.pending || !acceptId || acceptBlocked !== null}
            onClick={() =>
              void runAccept(async () => {
                // Re-read at submit time, exactly as the bond is. The quote
                // above is priced off this provider's score, and one more
                // attestation about them moves it - a stale figure is rejected
                // on chain as `collateral_below_required` after the gas is
                // spent.
                const engagement = await getEngagement(acceptId)
                const fresh = await collateralQuote(engagement.provider, engagement.stake)
                return acceptEngagement(address as string, acceptId, fresh.required)
              })
            }
          >
            {acceptState.pending ? 'Accepting…' : 'Accept and post collateral'}
          </button>
          <Outcome state={acceptState} verb="Engagement accepted." />
        </Step>

        <Step
          index={3}
          title="Close it"
          blurb="Marks the work finished, which is what opens attestation. Either counterparty may close."
        >
          <div className="field">
            <label htmlFor="close-id">Engagement id</label>
            <input
              id="close-id"
              className="input mono"
              value={closeId}
              placeholder="eng-001"
              onChange={(event) => setCloseId(event.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn"
            disabled={!canWrite || closeState.pending || !closeId}
            onClick={() => void runClose(() => closeEngagement(address as string, closeId))}
          >
            {closeState.pending ? 'Closing…' : 'Close engagement'}
          </button>
          <Outcome state={closeState} verb="Engagement closed." />
        </Step>

        <Step
          index={4}
          title="Attest"
          blurb="Grades your counterparty's side of a closed engagement. One model call, settled by validator consensus - this is the slow one."
        >
          <div className="field">
            <label htmlFor="attest-id">Engagement id</label>
            <input
              id="attest-id"
              className="input mono"
              value={attestId}
              placeholder="eng-001"
              onChange={(event) => setAttestId(event.target.value)}
            />
          </div>

          <BondNote bond={attestBond} note={attestNote} blocked={attestBlocked} />

          <div className="field">
            <label htmlFor="attest-claim">Claim</label>
            <textarea
              id="attest-claim"
              className="textarea"
              value={claim}
              placeholder="What you say happened."
              onChange={(event) => setClaim(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="attest-evidence">Evidence</label>
            <textarea
              id="attest-evidence"
              className="textarea"
              value={evidence}
              placeholder="What substantiates it. Unsubstantiated claims grade low and can slash the bond."
              onChange={(event) => setEvidence(event.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn"
            disabled={
              !canWrite ||
              attestState.pending ||
              !attestId ||
              !claim.trim() ||
              !evidence.trim() ||
              attestBond === null ||
              attestBlocked !== null
            }
            onClick={() =>
              void runAttest(async () => {
                // Re-read the bond at submit time. The quote above can be
                // minutes old, and it rises with every attestation this attester
                // has already made about this subject - a stale figure is
                // rejected on chain as `bond_below_required` after the gas is
                // spent. Reading it here costs one call and closes the window.
                const engagement = await getEngagement(attestId)
                const me = (address as string).toLowerCase()
                const subject =
                  engagement.client === me ? engagement.provider : engagement.client
                const bond = await bondForNext(me, subject)

                return attest(address as string, {
                  engagementId: attestId,
                  claim,
                  evidence,
                  bond,
                })
              })
            }
          >
            {attestState.pending ? 'Grading… this takes a moment' : 'Post attestation'}
          </button>
          <Outcome state={attestState} verb="Attestation posted." />
        </Step>

        <Step
          index={5}
          title="Reclaim the bond"
          blurb="Returns a releasable bond once its lock has elapsed. Only the attester can, and only if the grade did not slash it."
        >
          <div className="field">
            <label htmlFor="reclaim-id">Attestation id</label>
            <input
              id="reclaim-id"
              className="input mono"
              value={reclaimId}
              placeholder="0"
              inputMode="numeric"
              onChange={(event) => setReclaimId(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>

          <button
            type="button"
            className="btn"
            disabled={!canWrite || reclaimState.pending || reclaimId === ''}
            onClick={() =>
              void runReclaim(() => reclaimBond(address as string, Number(reclaimId)))
            }
          >
            {reclaimState.pending ? 'Reclaiming…' : 'Reclaim bond'}
          </button>
          <Outcome state={reclaimState} verb="Bond reclaimed." />
        </Step>

        <Step
          index={6}
          title="Release the collateral"
          blurb="Returns work collateral to the provider who posted it - once the grade cleared them, or once the engagement has been closed for the dispute window with nobody grading it at all."
        >
          <div className="field">
            <label htmlFor="release-id">Engagement id</label>
            <input
              id="release-id"
              className="input mono"
              value={releaseId}
              placeholder="eng-001"
              onChange={(event) => setReleaseId(event.target.value)}
            />
            <p className="hint">
              Provider only. A client who declines to attest cannot hold your capital
              indefinitely - after the lock it comes back ungraded.
            </p>
          </div>

          <button
            type="button"
            className="btn"
            disabled={!canWrite || releaseState.pending || !releaseId}
            onClick={() =>
              void runRelease(() => releaseCollateral(address as string, releaseId))
            }
          >
            {releaseState.pending ? 'Releasing…' : 'Release collateral'}
          </button>
          <Outcome state={releaseState} verb="Collateral released." />
        </Step>

        <Step
          index={7}
          title="Claim forfeited collateral"
          blurb="Pays the collateral to the client when a substantiated attestation found the work undelivered. Accusation alone does not forfeit it - the attestation has to carry weight in the score first."
        >
          <div className="field">
            <label htmlFor="claim-id">Engagement id</label>
            <input
              id="claim-id"
              className="input mono"
              value={claimId}
              placeholder="eng-001"
              onChange={(event) => setClaimId(event.target.value)}
            />
            <p className="hint">
              Client only, and only where step 4 graded the work below the forfeit threshold on
              evidence the score itself would count.
            </p>
          </div>

          <button
            type="button"
            className="btn"
            disabled={!canWrite || claimState.pending || !claimId}
            onClick={() => void runClaim(() => claimCollateral(address as string, claimId))}
          >
            {claimState.pending ? 'Claiming…' : 'Claim collateral'}
          </button>
          <Outcome state={claimState} verb="Collateral claimed." />
        </Step>
      </div>

      <p className="muted contract-note">
        Writing to <span className="mono">{shortAddress(CONTRACT_ADDRESS || '')}</span> on{' '}
        <strong>{NETWORK}</strong>.
      </p>
    </div>
  )
}

// --- pieces ---------------------------------------------------------------

function Step({
  index,
  title,
  blurb,
  children,
}: {
  index: number
  title: string
  blurb: string
  children: ReactNode
}) {
  return (
    <section className="card lifecycle__step">
      <header className="lifecycle__head">
        <span className="steps__index">{index}</span>
        <div>
          <h2 className="card__title">{title}</h2>
          <p className="muted">{blurb}</p>
        </div>
      </header>
      {children}
    </section>
  )
}

function WalletGate({
  address,
  available,
  rightChain,
  connecting,
  connect,
}: {
  address: string | null
  available: boolean
  rightChain: boolean | null
  connecting: boolean
  connect: () => Promise<void>
}) {
  // The same dialog the masthead opens. It carries the install list itself, so
  // the no-wallet case does not need a separate notice hard-coding one wallet.
  const { openPicker, picker } = useWalletPicker()

  if (address === null) {
    return (
      <div className="notice">
        <h2 className="notice__title">{available ? 'Connect to post' : 'A wallet is needed to post'}</h2>
        <p>
          {available
            ? 'The forms below stay disabled until a wallet is connected. Nothing is sent until you approve it, and the site never sees your key.'
            : 'Posting needs a browser wallet to sign with. Reading the registry does not - every page on this site renders without one.'}
        </p>
        <button type="button" className="btn" onClick={openPicker} disabled={connecting}>
          {connecting ? 'Connecting…' : available ? 'Connect wallet' : 'Choose a wallet'}
        </button>
        {picker}
      </div>
    )
  }

  if (rightChain === false) {
    return (
      <div className="notice notice--critical">
        <h2 className="notice__title">Wrong network</h2>
        <p>
          Your wallet is on another network. A transaction signed there would go somewhere this
          contract does not exist.
        </p>
        <button type="button" className="btn" onClick={() => void connect()}>
          Switch to {NETWORK}
        </button>
      </div>
    )
  }

  return null
}

/**
 * What the next attestation will cost, read from the contract.
 *
 * Resolved through the engagement rather than asked for: `bond_for_next` is
 * priced per attester-subject pair and rises with repetition, and the subject is
 * whichever counterparty the connected wallet is not. Quoting the policy minimum
 * instead would be right exactly once per pair.
 */
function useBond(engagementId: string, attester: string | null) {
  const [bond, setBond] = useState<bigint | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /**
   * Set when the contract will certainly refuse this attestation.
   *
   * The note alone was not enough. It said "close it before attesting" while the
   * button stayed live, so a visitor who read past it paid gas for a call the
   * contract rejects with `engagement_not_closed`. A hint that the form ignores
   * is not a guard.
   */
  const [blocked, setBlocked] = useState<string | null>(null)

  useEffect(() => {
    if (!engagementId || attester === null) {
      setBond(null)
      setNote(null)
      setBlocked(null)
      return
    }

    let live = true

    // Debounced, because this runs on every keystroke in the id field and costs
    // two reads each time. The studio RPC rate-limits at 30 requests a minute,
    // which typing a single engagement id can exhaust on its own.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const engagement = await getEngagement(engagementId)
          const me = attester.toLowerCase()
          const subject =
            engagement.client === me
              ? engagement.provider
              : engagement.provider === me
                ? engagement.client
                : null

          if (!live) return
          if (subject === null) {
            setBond(null)
            setNote(null)
            setBlocked('You are not a counterparty to this engagement.')
            return
          }

          // Every state that is not `closed` is a state the contract refuses,
          // and each refusal has a different remedy, so they are named rather
          // than collapsed into one message.
          if (engagement.state === 'proposed') {
            setBlocked(
              'This engagement has not been accepted by its provider yet, so there is nothing to grade.',
            )
          } else if (engagement.state === 'open') {
            setBlocked('This engagement is still open. Close it before attesting.')
          } else {
            setBlocked(null)
          }
          setNote(null)

          const required = await bondForNext(me, subject)
          if (live) setBond(required)
        } catch {
          // An id that does not resolve is the ordinary case while typing one.
          if (live) {
            setBond(null)
            setNote(null)
            setBlocked(null)
          }
        }
      })()
    }, 400)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [engagementId, attester])

  return { bond, note, blocked }
}

/**
 * What accepting this engagement would cost the connected wallet.
 *
 * Read through the engagement rather than asked for directly: the collateral is
 * priced off the *provider's* score against the stake the client committed, and
 * both of those live on chain. Quoting a policy constant instead would be right
 * for exactly one agent - the one with no history.
 */
function useCollateral(engagementId: string, provider: string | null) {
  const [quote, setQuote] = useState<CollateralQuote | null>(null)
  /** Set when the contract will certainly refuse this acceptance. */
  const [blocked, setBlocked] = useState<string | null>(null)

  useEffect(() => {
    if (!engagementId || provider === null) {
      setQuote(null)
      setBlocked(null)
      return
    }

    let live = true

    // Debounced for the same reason `useBond` is: this runs on every keystroke
    // in the id field and the studio RPC allows thirty requests a minute.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const engagement = await getEngagement(engagementId)
          if (!live) return

          if (engagement.provider !== provider.toLowerCase()) {
            setQuote(null)
            setBlocked('You are not the provider named on this engagement, so you cannot accept it.')
            return
          }
          if (engagement.state !== 'proposed') {
            setQuote(null)
            setBlocked('This engagement has already been accepted.')
            return
          }
          setBlocked(null)

          const fresh = await collateralQuote(engagement.provider, engagement.stake)
          if (live) setQuote(fresh)
        } catch {
          // An id that does not resolve is the ordinary case while typing one.
          if (live) {
            setQuote(null)
            setBlocked(null)
          }
        }
      })()
    }, 400)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [engagementId, provider])

  return { quote, blocked }
}

/**
 * The collateral quote, with the derivation shown rather than the figure alone.
 *
 * An amount on its own is a demand. The score, the rate it bought and the stake
 * it applies to are the explanation, and they are exactly the three numbers the
 * contract used - so a provider can check the price rather than trust it.
 */
function CollateralNote({
  quote,
  blocked,
}: {
  quote: CollateralQuote | null
  blocked: string | null
}) {
  if (quote === null && blocked === null) return null

  if (quote !== null && quote.stake === 0n) {
    return (
      <p className="hint bond-note">
        This engagement declares no value, so accepting it posts no collateral.
      </p>
    )
  }

  return (
    <p className={`hint bond-note${blocked !== null ? ' bond-note--blocked' : ''}`}>
      {quote !== null ? (
        <>
          Collateral required: <strong>{formatBond(quote.required)}</strong> -{' '}
          {bpToPercent(quote.rateBp)} of a {formatBond(quote.stake)} stake, at your score of{' '}
          {bpToScore(quote.scoreBp)}. Anything you send above it is returned in the same
          transaction.{' '}
        </>
      ) : null}
      {blocked}
    </p>
  )
}

function BondNote({
  bond,
  note,
  blocked,
}: {
  bond: bigint | null
  note: string | null
  blocked: string | null
}) {
  if (bond === null && note === null && blocked === null) return null

  return (
    <p className={`hint bond-note${blocked !== null ? ' bond-note--blocked' : ''}`}>
      {bond !== null ? (
        <>
          Bond required: <strong>{formatBond(bond)}</strong>.{' '}
        </>
      ) : null}
      {blocked ?? note}
    </p>
  )
}
