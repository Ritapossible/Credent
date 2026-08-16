/**
 * The write surface.
 *
 * Laid out as the engagement lifecycle rather than as a list of methods, because
 * the order is not optional: a scope has to be committed before the work, closed
 * after it, and only then can either side be graded on it. A page that offered
 * the four calls as equals would invite the sequence errors the contract then
 * rejects - `engagement_not_closed`, `sender_not_counterparty` - one gas fee at
 * a time.
 *
 * Every card writes with the visitor's own wallet. The site holds no key and
 * signs nothing; see `chain/wallet.ts`.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { CONTRACT_ADDRESS, EXPLORER_URL, IS_CONFIGURED, NETWORK } from '../chain/config'
import { bondForNext, getEngagement } from '../chain/oracle'
import { useWallet } from '../chain/useWallet'
import {
  attest,
  closeEngagement,
  openEngagement,
  reclaimBond,
  type WriteResult,
} from '../chain/wallet'
import { formatBond, shortAddress } from '../core/format'
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
  const [openState, runOpen] = useAction()

  const [closeId, setCloseId] = useState('')
  const [closeState, runClose] = useAction()

  const [attestId, setAttestId] = useState('')
  const [claim, setClaim] = useState('')
  const [evidence, setEvidence] = useState('')
  const [attestState, runAttest] = useAction()

  const [reclaimId, setReclaimId] = useState('')
  const [reclaimState, runReclaim] = useAction()

  // Read once here and passed down. Both the quoted cost and the button's
  // enabled state depend on it, and asking twice would be two chain reads per
  // keystroke in the engagement id.
  const { bond: attestBond, note: attestNote } = useBond(attestId, address)

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
          Four calls, in the order the protocol requires them. Each is signed by your own wallet -
          this site never holds a key. <Link to="/docs#protocol">How the lifecycle works →</Link>
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
            disabled={!canWrite || openState.pending || !openId || !openProvider || !openScope.trim()}
            onClick={() =>
              void runOpen(() =>
                openEngagement(address as string, {
                  engagementId: openId,
                  provider: normalizeAddress(openProvider),
                  scope: openScope,
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
          index={3}
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

          <BondNote bond={attestBond} note={attestNote} />

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
              attestBond === null
            }
            onClick={() =>
              void runAttest(() =>
                attest(address as string, {
                  engagementId: attestId,
                  claim,
                  evidence,
                  bond: attestBond ?? 0n,
                }),
              )
            }
          >
            {attestState.pending ? 'Grading… this takes a moment' : 'Post attestation'}
          </button>
          <Outcome state={attestState} verb="Attestation posted." />
        </Step>

        <Step
          index={4}
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
  if (!available) {
    return (
      <div className="notice notice--warning">
        <h2 className="notice__title">No wallet detected</h2>
        <p>
          Posting needs a browser wallet to sign with. Reading the registry does not - every page
          on this site renders without one.{' '}
          <a href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener">
            Install MetaMask →
          </a>
        </p>
      </div>
    )
  }

  if (address === null) {
    return (
      <div className="notice">
        <h2 className="notice__title">Connect to post</h2>
        <p>
          The forms below stay disabled until a wallet is connected. Nothing is sent until you
          approve it, and the site never sees your key.
        </p>
        <button type="button" className="btn" onClick={() => void connect()} disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
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

  useEffect(() => {
    if (!engagementId || attester === null) {
      setBond(null)
      setNote(null)
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
            setNote('You are not a counterparty to this engagement.')
            return
          }

          setNote(
            engagement.closed
              ? null
              : 'This engagement is still open. Close it before attesting.',
          )
          const required = await bondForNext(me, subject)
          if (live) setBond(required)
        } catch {
          // An id that does not resolve is the ordinary case while typing one.
          if (live) {
            setBond(null)
            setNote(null)
          }
        }
      })()
    }, 400)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [engagementId, attester])

  return { bond, note }
}

function BondNote({ bond, note }: { bond: bigint | null; note: string | null }) {
  if (bond === null && note === null) return null

  return (
    <p className="hint bond-note">
      {bond !== null ? (
        <>
          Bond required: <strong>{formatBond(bond)}</strong>.{' '}
        </>
      ) : null}
      {note}
    </p>
  )
}
