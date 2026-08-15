import { useState } from 'react'

import { bpToPercent, formatBond, formatDuration, shortAddress, shortDigest } from '../core/format'
import type { GradedAttestation } from '../chain/registry'
import type { Verdict } from '../core/bonding'

const VERDICT_LABEL: Record<Verdict, string> = {
  fulfilled: 'Fulfilled',
  partial: 'Partially fulfilled',
  unfulfilled: 'Unfulfilled',
  ungraded: 'Ungraded',
}

/**
 * Status tone per verdict. These are the reserved status colors, never the
 * categorical series slots - and each ships with its label, so the color is never
 * the only thing carrying the state.
 */
const VERDICT_TONE: Record<Verdict, string> = {
  fulfilled: 'good',
  partial: 'warning',
  unfulfilled: 'critical',
  ungraded: 'neutral',
}

export default function AttestationCard({ attestation }: { attestation: GradedAttestation }) {
  const [open, setOpen] = useState(false)
  const { breakdown } = attestation
  const tone = VERDICT_TONE[attestation.verdict]

  return (
    <article className="att">
      <header className="att__head">
        <div className="att__who">
          <h3 className="att__attester mono" title={attestation.attester}>
            {shortAddress(attestation.attester)}
          </h3>
          <p className="muted att__meta">
            {formatDuration(attestation.ageSeconds)} ago
            {attestation.repeatIndex > 0
              ? ` · attestation #${attestation.repeatIndex + 1} from this counterparty`
              : ' · first attestation from this counterparty'}
          </p>
        </div>
        <span className={`chip chip--${tone}`}>
          <VerdictIcon verdict={attestation.verdict} />
          {VERDICT_LABEL[attestation.verdict]}
        </span>
      </header>

      <dl className="att__scope">
        <dt>Committed scope</dt>
        <dd>{attestation.scope}</dd>
        <dt>Attested outcome</dt>
        <dd>{attestation.claim}</dd>
      </dl>

      <div className="att__grades">
        <Grade label="Outcome grade" value={bpToPercent(attestation.gradeBp, 0)} />
        <Grade
          label="Substantiated"
          value={`${attestation.substantiated} / 100`}
          flag={attestation.breakdown.gatedBy === 'substantiated'}
        />
        <Grade
          label="Confidence"
          value={`${attestation.confidence} / 100`}
          flag={attestation.breakdown.gatedBy === 'confidence'}
        />
        <Grade label="Weight carried" value={attestation.weight.toLocaleString('en-US')} />
      </div>

      <button
        type="button"
        className="att__disclose"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide derivation' : 'Show derivation'}
      </button>

      {open ? (
        <div className="att__detail">
          {breakdown.gatedBy ? (
            <p className="att__gated">
              Gated: {breakdown.gatedBy === 'confidence' ? 'confidence' : 'substantiation'} fell
              below the policy floor, so this attestation contributed no weight at all. It still
              appears in the record - a gated attestation is suppressed, not hidden.
            </p>
          ) : (
            <ol className="derivation">
              <li>
                <span>Base from substantiation ({attestation.substantiated}/100)</span>
                <strong>{breakdown.base.toLocaleString('en-US')}</strong>
              </li>
              <li>
                <span>
                  After repeat damping
                  {breakdown.repeatShiftBits > 0
                    ? ` (halved ${breakdown.repeatShiftBits}×)`
                    : ' (first attestation, undamped)'}
                </span>
                <strong>{breakdown.afterRepeat.toLocaleString('en-US')}</strong>
              </li>
              <li>
                <span>After decay ({formatDuration(attestation.ageSeconds)} old)</span>
                <strong>{breakdown.weight.toLocaleString('en-US')}</strong>
              </li>
              <li className="derivation__loss">
                <span>Lost to decay</span>
                <strong>−{breakdown.decayLossBp.toLocaleString('en-US')}</strong>
              </li>
            </ol>
          )}

          <dl className="att__digests">
            <div>
              <dt>Bond posted</dt>
              <dd>{formatBond(attestation.bond)}</dd>
            </div>
            <div>
              <dt>Bond outcome</dt>
              <dd className={attestation.outcome === 'slashed' ? 'att__slashed' : undefined}>
                {attestation.outcome === 'slashed' ? 'Slashed' : 'Releasable'}
              </dd>
            </div>
            <div>
              <dt>Scope digest</dt>
              <dd className="mono" title={attestation.scopeDigestHex}>
                {shortDigest(attestation.scopeDigestHex)}
              </dd>
            </div>
            <div>
              <dt>Prompt salt</dt>
              <dd className="mono" title={attestation.salt}>
                {shortDigest(attestation.salt)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </article>
  )
}

function Grade({ label, value, flag }: { label: string; value: string; flag?: boolean }) {
  return (
    <div className={`grade${flag ? ' grade--flag' : ''}`}>
      <span className="grade__label">{label}</span>
      <span className="grade__value">{value}</span>
    </div>
  )
}

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  const paths: Record<Verdict, string> = {
    fulfilled: 'M4 8.5l3 3 5-6',
    partial: 'M8 3v6M8 12h.01',
    unfulfilled: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    ungraded: 'M4 8h8',
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d={paths[verdict]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
