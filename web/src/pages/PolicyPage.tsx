import { Link } from 'react-router-dom'

import { PARAMETER_NOTES } from '../content/parameters'
import { DEFAULT_POLICY, type Policy } from '../core/policy'
import { formatBond, formatCount, formatDuration } from '../core/format'
import { useEffectivePolicy } from '../chain/useOracle'

/**
 * How each parameter is rendered, keyed by the same `Policy` field the notes use.
 * The labels and the reasoning live in `content/parameters`; this file only knows
 * how to turn a value into a string.
 */
const RENDER: Record<keyof Policy, (policy: Policy) => string> = {
  halfLifeSeconds: (policy) => formatDuration(policy.halfLifeSeconds),
  priorWeight: (policy) => `${formatCount(policy.priorWeight)} bp`,
  minSubstantiated: (policy) => `${policy.minSubstantiated} / 100`,
  minConfidence: (policy) => `${policy.minConfidence} / 100`,
  confidenceTol: (policy) => `±${policy.confidenceTol}`,
  repeatShiftCap: (policy) => `${policy.repeatShiftCap} halvings`,
  minBond: (policy) => (policy.minBond === 0n ? 'None' : formatBond(policy.minBond)),
  slashFloor: (policy) => `${policy.slashFloor} substantiated`,
  releaseFloor: (policy) => `${policy.releaseFloor} substantiated`,
  bondLockSeconds: (policy) => formatDuration(policy.bondLockSeconds),
}

export default function PolicyPage() {
  const { policy, live } = useEffectivePolicy()

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Policy</p>
        <h1>Every parameter the deployed contract runs on</h1>
        <p className="lede">
          Read from <code className="mono">get_policy</code> on the contract this build points at,
          not from a constant in the source. The contract defaults are shown beside them; a changed
          value is marked. Each name links to the reasoning behind it.
        </p>
      </div>

      {/* The distinction this page exists to make. It previously rendered the
          repo's intended constant under the heading "deploys with", which was a
          claim about the deployment that nothing verified - and on a deployment
          carrying `min_bond = 0` it was quoting a bond nobody was charged. */}
      {live ? null : (
        <div className="notice notice--warning">
          <h2 className="notice__title">Showing intended values, not deployed ones</h2>
          <p>
            The deployed policy could not be read, so the table below is this repository's intended
            configuration. It is not a statement about the live contract.
          </p>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table policy-table">
          <caption className="visually-hidden">
            Deployed policy values against contract defaults
          </caption>
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">{live ? 'Deployed' : 'Intended'}</th>
              <th scope="col">Contract default</th>
            </tr>
          </thead>
          <tbody>
            {PARAMETER_NOTES.map((note) => {
              const render = RENDER[note.key]
              const current = render(policy)
              const fallback = render(DEFAULT_POLICY)
              const differs = current !== fallback
              return (
                <tr key={note.key}>
                  <th scope="row">
                    <Link to={`/docs#${note.anchor}`}>{note.label}</Link>
                  </th>
                  <td className={differs ? 'policy-table__changed' : undefined}>{current}</td>
                  <td className="muted">{fallback}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <section className="band">
        <div className="grid grid--2">
          <div className="notice">
            <h3 className="notice__title">Integer arithmetic throughout</h3>
            <p>
              Every value above is an integer, and every derived figure stays one - two validators
              have to reach byte-identical results.{' '}
              <Link to="/docs#integer-arithmetic">Why floats fail here →</Link>
            </p>
          </div>
          <div className={policy.minBond > 0n ? 'notice' : 'notice notice--critical'}>
            <h3 className="notice__title">
              {policy.minBond > 0n ? 'The economic layer is on' : 'The economic layer is off'}
            </h3>
            <p>
              The contract <em>defaults</em> to <code>minBond = 0</code>, which switches it off
              entirely: attesting is free, so the bond curve that makes sybil attestation
              unprofitable never charges anyone. No scoring math changes either way.{' '}
              {policy.minBond > 0n ? (
                <>
                  This deployment sets it to <strong>{formatBond(policy.minBond)}</strong>.
                </>
              ) : (
                <>
                  <strong>This deployment leaves it at zero</strong>, so every figure on the attack
                  cost page describes a defence it is not currently running.
                </>
              )}{' '}
              <Link to="/docs#bond-switched-off">What that costs →</Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
