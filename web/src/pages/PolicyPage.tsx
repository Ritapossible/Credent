import { CREDENT_POLICY, DEFAULT_POLICY, type Policy } from '../core/policy'
import { formatBond, formatCount, formatDuration } from '../core/format'

interface Row {
  key: keyof Policy
  label: string
  render: (policy: Policy) => string
  why: string
}

const ROWS: Row[] = [
  {
    key: 'halfLifeSeconds',
    label: 'Half-life',
    render: (policy) => formatDuration(policy.halfLifeSeconds),
    why: 'Age at which an attestation is worth half what it was. Long enough that a real track record persists, short enough that a reputation has to be maintained rather than banked.',
  },
  {
    key: 'priorWeight',
    label: 'Neutral prior',
    render: (policy) => `${formatCount(policy.priorWeight)} bp`,
    why: 'Three full attestations worth of inertia toward 50. This is what stops one review from producing a perfect agent, and what makes "unknown" read differently from "bad".',
  },
  {
    key: 'minSubstantiated',
    label: 'Substantiation floor',
    render: (policy) => `${policy.minSubstantiated} / 100`,
    why: 'Below this an attestation contributes nothing at all. A claim with no support is not worth partial credit — it is worth nothing, and gets a bond slashed if it falls further.',
  },
  {
    key: 'minConfidence',
    label: 'Confidence floor',
    render: (policy) => `${policy.minConfidence} / 100`,
    why: "The model's certainty about its own reading. It gates rather than scales, so the score tracks evidence instead of hesitancy.",
  },
  {
    key: 'confidenceTol',
    label: 'Validator tolerance',
    render: (policy) => `±${policy.confidenceTol}`,
    why: 'Allowed spread between leader and validator on each graded field. Tight enough to catch disagreement, loose enough that two honest readings of the same prose still agree.',
  },
  {
    key: 'repeatShiftCap',
    label: 'Repeat damping cap',
    render: (policy) => `${policy.repeatShiftCap} halvings`,
    why: 'Largest damping shift, so weight cannot underflow to nothing from volume alone. A prolific but honest counterparty still counts for something.',
  },
  {
    key: 'minBond',
    label: 'First-attestation bond',
    render: (policy) => (policy.minBond === 0n ? 'None' : formatBond(policy.minBond)),
    why: 'What it costs to attest once. Doubles on each repeat about the same subject, mirroring the halving in weight.',
  },
  {
    key: 'slashFloor',
    label: 'Slash floor',
    render: (policy) => `${policy.slashFloor} substantiated`,
    why: 'Below this the bond is slashed. Keyed on substantiation, never on sentiment — slashing negative reviews would turn the oracle into a praise machine.',
  },
  {
    key: 'releaseFloor',
    label: 'Release floor',
    render: (policy) => `${policy.releaseFloor} substantiated`,
    why: 'At or above this the bond comes back in full. Between the two floors it is returned but the attestation carries reduced weight.',
  },
  {
    key: 'bondLockSeconds',
    label: 'Bond lock',
    render: (policy) => formatDuration(policy.bondLockSeconds),
    why: 'How long a releasable bond stays locked before reclaim, leaving room for a dispute to surface before the collateral leaves.',
  },
]

export default function PolicyPage() {
  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow">Policy</p>
        <h1>Every parameter, and why it is set there</h1>
        <p className="lede">
          These are the values Credent deploys with. The contract defaults are shown beside them —
          the one deliberate departure is the bond, because at <code>minBond = 0</code> the economic
          layer is switched off entirely: attesting is free, so the curve that makes sybil
          attestation unprofitable never charges anyone. No scoring math changes with it.
        </p>
      </div>

      <div className="table-wrap">
        <table className="data-table policy-table">
          <caption className="visually-hidden">
            Credent policy values against contract defaults, with the reasoning for each
          </caption>
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">Credent</th>
              <th scope="col">Contract default</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => {
              const credent = row.render(CREDENT_POLICY)
              const fallback = row.render(DEFAULT_POLICY)
              const differs = credent !== fallback
              return (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className={differs ? 'policy-table__changed' : undefined}>{credent}</td>
                  <td className="muted">{fallback}</td>
                  <td className="policy-table__why">{row.why}</td>
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
              Every value above is an integer, and every derived figure stays one. Two validators
              have to reach byte-identical results, and a float would let them disagree in the last
              place — which in consensus is not a rounding difference, it is a failed block. Basis
              points give four decimal places of resolution without ever leaving integers.
            </p>
          </div>
          <div className="notice">
            <h3 className="notice__title">Why this interface recomputes rather than reads</h3>
            <p>
              The numbers on this site are derived in your browser by the same steps the contract
              runs, ported function for function. That is more work than fetching a stored score,
              and it is the point: an interface that approximates the math would eventually quote a
              number the chain does not agree with, which is worse than showing nothing.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
