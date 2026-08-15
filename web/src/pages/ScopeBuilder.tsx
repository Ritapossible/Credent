import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { attestationSalt, normalizeAddress, scopeDigest } from '../core/digest'
import { CREDENT_POLICY } from '../core/policy'
import { formatBond, formatDuration, shortAddress } from '../core/format'

const EXAMPLE = {
  scope:
    'Route 2.4M USDC from Base to Arbitrum within 40 minutes, total slippage under 8bp, no single venue above 60% of volume.',
  attester: '0xC41D8E7B2A9F5C3E1D6B8A4F2C7E9D5B3A1F8C62',
  subject: '0x7a3f9c2e5b8d1a4f6c0e9b2d7a5f3c1e8b6d4a29',
  claim: 'Completed in 31 minutes at 5.1bp total slippage. Venue split 44/33/23.',
}

export default function ScopeBuilder() {
  const [scope, setScope] = useState(EXAMPLE.scope)
  const [attester, setAttester] = useState(EXAMPLE.attester)
  const [subject, setSubject] = useState(EXAMPLE.subject)
  const [claim, setClaim] = useState(EXAMPLE.claim)

  // Digests are computed synchronously inside render on purpose: `crypto.subtle`
  // is async and would flash a stale digest as the client types.
  const digest = useMemo(() => scopeDigest(scope), [scope])
  const salt = useMemo(
    () => attestationSalt({ scope, attester, subject, claim }),
    [scope, attester, subject, claim],
  )

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Scope builder</p>
        <h1>Commit the standard before the outcome is known</h1>
        <p className="lede">
          The scope digest is what proves the bar did not move. Both digests below update as you
          type. <Link to="/docs#commitments">How the commitments work →</Link>
        </p>
      </div>

      <div className="builder">
        <form className="builder__form card" onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="scope">Engagement scope</label>
            <textarea
              id="scope"
              className="textarea"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            />
            <p className="hint">
              Specific enough to grade against. Vague scopes produce low substantiation later.
            </p>
          </div>

          <div className="field">
            <label htmlFor="attester">Attester address</label>
            <input
              id="attester"
              className="input mono"
              value={attester}
              onChange={(event) => setAttester(event.target.value)}
            />
            <p className="hint">Case-folded before hashing.</p>
          </div>

          <div className="field">
            <label htmlFor="subject">Subject address</label>
            <input
              id="subject"
              className="input mono"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="claim">Attested outcome</label>
            <textarea
              id="claim"
              className="textarea"
              value={claim}
              onChange={(event) => setClaim(event.target.value)}
            />
          </div>
        </form>

        <div className="builder__out">
          <div className="card">
            <h2 className="card__title">Scope digest</h2>
            <p className="muted">
              SHA-256 over the canonical JSON encoding of the scope string.{' '}
              <Link to="/docs#scope-digest">Details →</Link>
            </p>
            <output className="digest mono">{digest}</output>
          </div>

          <div className="card">
            <h2 className="card__title">Attestation salt</h2>
            <p className="muted">
              Derived from content, never randomness - yet still unpredictable to the attester.{' '}
              <Link to="/docs#attestation-salt">Details →</Link>
            </p>
            <output className="digest mono">{salt}</output>
            <p className="hint digest__material">
              scopeDigest │ {shortAddress(normalizeAddress(attester)) || '-'} │{' '}
              {shortAddress(normalizeAddress(subject)) || '-'} │ claim
            </p>
          </div>

          <div className="card">
            <h2 className="card__title">
              What posting this costs <Link className="card__link" to="/docs#bond-cost">Details →</Link>
            </h2>
            <dl className="mini-facts">
              <div>
                <dt>First attestation bond</dt>
                <dd>{formatBond(CREDENT_POLICY.minBond)}</dd>
              </div>
              <div>
                <dt>Lock before reclaim</dt>
                <dd>{formatDuration(CREDENT_POLICY.bondLockSeconds)}</dd>
              </div>
              <div>
                <dt>Slashed below</dt>
                <dd>{CREDENT_POLICY.slashFloor} substantiated</dd>
              </div>
              <div>
                <dt>Released at or above</dt>
                <dd>{CREDENT_POLICY.releaseFloor} substantiated</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
