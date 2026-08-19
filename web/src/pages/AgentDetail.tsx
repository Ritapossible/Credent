import { Link, useParams } from 'react-router-dom'

import ScoreMeter from '../components/ScoreMeter'
import StatTile from '../components/StatTile'
import WeightBars from '../components/WeightBars'
import AttestationCard from '../components/AttestationCard'
import ChainState from '../components/ChainState'
import { useAgent } from '../chain/useOracle'
import { isDeployed } from '../chain/config'
import type { AgentReport } from '../chain/registry'
import { bpToPercent, bpToScore, formatBond, formatCount, shortAddress } from '../core/format'
import { collateralRateBp, collateralRequired } from '../core/collateral'
import { NEUTRAL_BP } from '../core/policy'

/**
 * The engagement this page prices the agent's record against.
 *
 * An illustration, labelled as one: the contract prices whatever stake a client
 * declares, and the interesting quantity is the *ratio* between what this agent
 * posts and what an agent with no record would - which is the same at any stake.
 */
const EXAMPLE_STAKE = 100n * 10n ** 18n

export default function AgentDetail() {
  const { address = '' } = useParams()

  // Checked before the read rather than after: `get_report` answers for any
  // well-formed address, so a malformed one is the only case the contract cannot
  // speak to, and it deserves a different message than "no history".
  if (!isDeployed(address)) {
    return (
      <div className="shell page">
        <div className="section-head">
          <p className="eyebrow eyebrow--pill">Not an address</p>
          <h1>That is not a valid agent address</h1>
          <p className="lede">
            An agent is identified by its 20-byte account address.{' '}
            <Link to="/docs#protocol">How agents are identified →</Link>
          </p>
        </div>
        <Link className="btn" to="/agents">
          Back to the registry
        </Link>
      </div>
    )
  }

  return <AgentBody address={address} />
}

function AgentBody({ address }: { address: string }) {
  const state = useAgent(address)

  return (
    <div className="shell page">
      <p className="crumb">
        <Link to="/agents">Registry</Link> <span aria-hidden="true">/</span>{' '}
        <span className="mono">{shortAddress(address)}</span>
      </p>

      <ChainState state={state} what="this agent">
        {(agent) => <AgentReportView agent={agent} />}
      </ChainState>
    </div>
  )
}

function AgentReportView({ agent }: { agent: AgentReport }) {
  const { report, attestations, concentrationBp } = agent
  const gated = attestations.filter((entry) => entry.weight === 0)
  const slashed = attestations.filter((entry) => entry.outcome === 'slashed')

  return (
    <>
      <div className="detail-head">
        <div>
          <p className="eyebrow">Agent</p>
          <h1 className="mono">{shortAddress(agent.address)}</h1>
          <p className="mono detail-head__address">{agent.address}</p>
          <p className="lede">
            {report.nAttestations === 0
              ? 'No attestations on record. The score is the neutral prior, not a judgement.'
              : `${report.nAttestations} attestation${
                  report.nAttestations === 1 ? '' : 's'
                } from ${report.nDistinctAttesters} distinct attester${
                  report.nDistinctAttesters === 1 ? '' : 's'
                }.`}
          </p>
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
          note={`Against a ${formatCount(agent.policy.priorWeight)} bp neutral prior`}
        />
        <StatTile
          label="Top attester share"
          value={bpToPercent(concentrationBp, 0)}
          note="Concentration of that weight"
        />
      </section>

      <section className="band">
        <div className="notice">
          <h3 className="notice__title">What this record is worth</h3>
          <p>
            To take on work declared at {formatBond(EXAMPLE_STAKE)}, this agent must post{' '}
            <strong>
              {formatBond(collateralRequired(report.scoreBp, EXAMPLE_STAKE, agent.policy))}
            </strong>{' '}
            of its own funds - {bpToPercent(collateralRateBp(report.scoreBp, agent.policy))} of the
            stake, at a score of {bpToScore(report.scoreBp)}. An agent with no record at all would
            post{' '}
            {formatBond(collateralRequired(NEUTRAL_BP, EXAMPLE_STAKE, agent.policy))} for the same
            job. The contract checks this before it will let the engagement open.{' '}
            <Link to="/docs#work-collateral">How collateral is priced →</Link>
          </p>
        </div>
      </section>

      {attestations.length === 0 ? (
        <section className="band">
          <div className="notice">
            <h3 className="notice__title">Nothing attested yet</h3>
            <p>
              This address has no attestations on the deployed contract, so it scores exactly
              neutral. <Link to="/docs#unknown-is-not-bad">Unknown is not bad →</Link>
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="band">
            <WeightBars attestations={attestations} />
          </section>

          <section className="band">
            <div className="section-head">
              <p className="eyebrow">Attestations</p>
              <h2>Every claim, and what it was worth</h2>
              <p className="muted">
                The committed scope digest, the graded fields, and the arithmetic from raw
                substantiation to carried weight.
              </p>
            </div>

            <div className="attestation-list">
              {attestations.map((entry) => (
                <AttestationCard key={entry.id} attestation={entry} />
              ))}
            </div>
          </section>
        </>
      )}

      {slashed.length > 0 ? (
        <section className="band">
          <div className="notice notice--critical">
            <h3 className="notice__title">
              {slashed.length} bond{slashed.length === 1 ? '' : 's'} slashed
            </h3>
            <p>
              These attestations asserted without support. Slashing keys on substantiation, never
              on sentiment. <Link to="/docs#slashing">What that means →</Link>
            </p>
          </div>
        </section>
      ) : null}
    </>
  )
}
