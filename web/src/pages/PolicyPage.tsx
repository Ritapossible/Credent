import { Link } from 'react-router-dom'

import { PARAMETER_NOTES } from '../content/parameters'
import { CREDENT_POLICY, DEFAULT_POLICY, type Policy } from '../core/policy'
import { formatBond, formatCount, formatDuration } from '../core/format'

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
  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Policy</p>
        <h1>Every parameter Credent deploys with</h1>
        <p className="lede">
          The contract defaults are shown beside them; a changed value is marked. Each name links
          to the reasoning behind it.
        </p>
      </div>

      <div className="table-wrap">
        <table className="data-table policy-table">
          <caption className="visually-hidden">
            Credent policy values against contract defaults
          </caption>
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">Credent</th>
              <th scope="col">Contract default</th>
            </tr>
          </thead>
          <tbody>
            {PARAMETER_NOTES.map((note) => {
              const render = RENDER[note.key]
              const credent = render(CREDENT_POLICY)
              const fallback = render(DEFAULT_POLICY)
              const differs = credent !== fallback
              return (
                <tr key={note.key}>
                  <th scope="row">
                    <Link to={`/docs#${note.anchor}`}>{note.label}</Link>
                  </th>
                  <td className={differs ? 'policy-table__changed' : undefined}>{credent}</td>
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
              Every value above is an integer, and every derived figure stays one — two validators
              have to reach byte-identical results.{' '}
              <Link to="/docs#integer-arithmetic">Why floats fail here →</Link>
            </p>
          </div>
          <div className="notice">
            <h3 className="notice__title">One deliberate departure</h3>
            <p>
              The contract defaults to <code>minBond = 0</code>, which switches the economic layer
              off entirely. No scoring math changes with it.{' '}
              <Link to="/docs#bond-switched-off">What that costs →</Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
