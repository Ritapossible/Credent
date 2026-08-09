import { Link, useParams } from 'react-router-dom'

import ScoreMeter from '../components/ScoreMeter'
import StatTile from '../components/StatTile'
import WeightBars from '../components/WeightBars'
import AttestationCard from '../components/AttestationCard'
import { buildReport } from '../core/registry'
import { findAgent } from '../core/fixtures'
import { CREDENT_POLICY } from '../core/policy'
import { bpToPercent, formatCount, formatDuration } from '../core/format'

export default function AgentDetail() {
  const { address = '' } = useParams()
  const agent = findAgent(address)

  if (!agent) {
    return (
      <div className="shell page">
        <div className="section-head">
          <p className="eyebrow">Not found</p>
          <h1>No agent at that address</h1>
          <p className="lede">
            The registry runs on fixtures while the contract is pre-deployment, so only the four
            demo agents resolve.
          </p>
        </div>
        <Link className="btn" to="/agents">
          Back to the registry
        </Link>
      </div>
    )
  }

  const { report, attestations, concentrationBp } = buildReport(agent)
  const gated = attestations.filter((entry) => entry.weight === 0)
  const slashed = attestations.filter((entry) => entry.outcome === 'slashed')

  return (
    <div className="shell page">
      <p className="crumb">
        <Link to="/agents">Registry</Link> <span aria-hidden="true">/</span> {agent.name}
      </p>

      <div className="detail-head">
        <div>
          <p className="eyebrow">{agent.role}</p>
          <h1>{agent.name}</h1>
          <p className="mono detail-head__address">{agent.address}</p>
          <p className="lede">{agent.summary}</p>
        </div>
        <div className="detail-head__meter card">
          <ScoreMeter
            scoreBp={report.scoreBp}
            counted={report.nCounted}
            size="hero"
            label="Reputation score"
          />
        </div>
      </div>

      <section className="kpi-row" aria-label="Report summary">
        <StatTile
          label="Counted attestations"
          value={`${report.nCounted} of ${report.nAttestations}`}
          note={gated.length ? `${gated.length} gated on floors` : 'All carried weight'}
        />
        <StatTile
          label="Distinct attesters"
          value={String(report.nDistinctAttesters)}
          note="Independent voices behind the score"
        />
        <StatTile
          label="Total weight"
          value={formatCount(report.totalWeight)}
          note={`Against a ${formatCount(CREDENT_POLICY.priorWeight)} bp neutral prior`}
        />
        <StatTile
          label="Top attester share"
          value={bpToPercent(concentrationBp, 0)}
          note="Concentration of that weight"
        />
      </section>

      <section className="band">
        <WeightBars attestations={attestations} />
      </section>

      <section className="band">
        <div className="section-head">
          <p className="eyebrow">Attestations</p>
          <h2>Every claim, and what it was worth</h2>
          <p className="muted">
            Each card shows the committed scope digest, the graded fields, and the arithmetic that
            took the attestation from a raw substantiation score to the weight it carried.
          </p>
        </div>

        <div className="attestation-list">
          {attestations.map((entry) => (
            <AttestationCard key={entry.id} attestation={entry} />
          ))}
        </div>
      </section>

      {slashed.length > 0 ? (
        <section className="band">
          <div className="notice notice--critical">
            <h3 className="notice__title">
              {slashed.length} bond{slashed.length === 1 ? '' : 's'} slashed
            </h3>
            <p>
              Slashing keys on substantiation, never on sentiment. These attestations asserted
              without support — a negative attestation backed by evidence is never at risk. The
              bond stays locked for {formatDuration(CREDENT_POLICY.bondLockSeconds)} before reclaim.
            </p>
          </div>
        </section>
      ) : null}
    </div>
  )
}
