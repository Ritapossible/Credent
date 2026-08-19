import { Link } from 'react-router-dom'

import ScoreMeter from '../components/ScoreMeter'
import StatTile from '../components/StatTile'
import { useDeployedPolicy, useRegistry } from '../chain/useOracle'
import type { AgentReport } from '../chain/registry'
import { CREDENT_POLICY, NEUTRAL_BP, type Policy } from '../core/policy'
import { collateralRequired } from '../core/collateral'
import { repeatPenalty } from '../core/simulate'
import { bpToScore, formatBond, formatCount, formatDuration, shortAddress } from '../core/format'

/**
 * The engagement the hero prices collateral against.
 *
 * A hundred whole tokens, chosen so the figure beside a score reads as money
 * rather than as a rate. It is an illustration and says so; the contract prices
 * whatever stake a client actually declares.
 */
const EXAMPLE_STAKE = 100n * 10n ** 18n

/** One line each; the full account of every step lives at `/docs#protocol`. */
const STEPS = [
  { title: 'An engagement closes', body: 'The scope is hashed on open.' },
  { title: 'A counterparty attests', body: 'One party, once, against a bond.' },
  { title: 'Validators grade it', body: 'Outcome and support, scored separately.' },
  { title: 'The score sets collateral', body: 'One number decides what gets posted.' },
]

const DECISIONS = [
  {
    title: 'Unknown is not bad',
    body: 'No attestations means exactly 50, and the prior pulls thin histories toward it.',
    anchor: 'unknown-is-not-bad',
  },
  {
    title: 'Volume is not standing',
    body: 'Each repeat from one counterparty is worth half the last, and costs twice as much.',
    anchor: 'volume-is-not-standing',
  },
  {
    title: 'Criticism is never punished',
    body: 'Bonds slash on unsubstantiated claims, never on negative ones.',
    anchor: 'criticism-is-never-punished',
  },
]

export default function Overview() {
  // The landing page never blocks on the chain: the parameters and the protocol
  // explanation are true regardless of what is deployed, so the worked example is
  // the only part that waits, and it simply omits itself until the read lands.
  const { data: registry } = useRegistry()
  const strongest = registry?.[0] ?? null

  // The tiles below are labelled "deployed parameters", so they have to be the
  // deployed ones. `CREDENT_POLICY` stands in only for the moment before the read
  // lands - it is this repo's intended configuration, so the tiles never flash a
  // number that contradicts the deployment by more than the shipped default.
  const { data: deployed } = useDeployedPolicy()
  const policy = deployed ?? CREDENT_POLICY
  const penalty = repeatPenalty(policy)

  return (
    <>
      <section className="hero">
        <div className="shell hero__inner">
          <div className="hero__copy">
            <h1 className="hero__title">
              An agent's history should decide what it has to put up front.
            </h1>
            <p className="lede">
              Credent grades counterparty attestations in consensus on GenLayer and turns the result
              into a collateral requirement. Nobody is asked to trust a self-report.
            </p>
            <div className="hero__actions">
              <Link className="btn" to="/agents">
                Browse the registry
              </Link>
              <Link className="btn btn--ghost" to="/docs">
                Read the docs
              </Link>
            </div>
          </div>

          {/* The right half of the fold used to be empty plane. It carries the
              thing the sentence on the left is about instead - and it is the real
              record, read from the deployed contract, rather than a mock. */}
          <StandingPreview agent={strongest} policy={policy} />
        </div>
      </section>

      <div className="shell page">
        <section className="kpi-row" aria-label="Deployed parameters">
          <StatTile
            label="Attestation half-life"
            value={formatDuration(policy.halfLifeSeconds)}
            note="Weight halves at this age"
          />
          <StatTile
            label="Neutral prior"
            value={`${policy.priorWeight.toLocaleString('en-US')} bp`}
            note="Three full attestations of inertia"
          />
          <StatTile
            label="First-attestation bond"
            value={policy.minBond > 0n ? formatBond(policy.minBond) : 'None required'}
            note={policy.minBond > 0n ? 'Doubles on every repeat' : 'Bonding is off on this deployment'}
          />
          <StatTile
            label="Repeat cost penalty"
            value={`${formatCount(Math.round(penalty))}×`}
            note="Per unit of weight, at the cap"
          />
        </section>

        <section className="band">
          <div className="section-head">
            <p className="eyebrow">How it works</p>
            <h2>Four steps, none of which take the agent's word for anything</h2>
          </div>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="steps__item">
                <span className="steps__index" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <h3 className="steps__title">{step.title}</h3>
                  <p className="muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="band__more">
            <Link to="/docs#protocol">Walk through each step →</Link>
          </p>
        </section>

        <section className="band">
          <div className="section-head">
            <p className="eyebrow">The design decisions that matter</p>
            <h2>Three choices that keep the number honest</h2>
          </div>

          <div className="grid grid--3">
            {DECISIONS.map((decision) => (
              <article key={decision.anchor} className="card">
                <h3 className="card__title">{decision.title}</h3>
                <p className="muted">{decision.body}</p>
                <p className="card__aside">
                  <Link to={`/docs#${decision.anchor}`}>Why →</Link>
                </p>
              </article>
            ))}
          </div>
        </section>

        {strongest ? (
          <section className="band">
            <div className="section-head">
              <p className="eyebrow">Worked example</p>
              <h2>What a strong record actually looks like</h2>
            </div>
            <div className="feature">
              <div>
                <h3 className="feature__name mono">{shortAddress(strongest.address)}</h3>
                <p className="muted feature__role">
                  The highest-scoring agent currently on the contract
                </p>
                <p className="muted">
                  Its standing is the shrunk weighted mean of{' '}
                  {strongest.report.nAttestations} attestation
                  {strongest.report.nAttestations === 1 ? '' : 's'}, decayed by age and damped for
                  repeat counterparties.
                </p>
                <Link className="btn btn--ghost" to={`/agents/${strongest.address}`}>
                  Open the full report
                </Link>
              </div>
              <div className="feature__figure">
                <span className="feature__score">{bpToScore(strongest.report.scoreBp)}</span>
                <span className="muted">
                  from {strongest.report.nCounted} counted attestations across{' '}
                  {strongest.report.nDistinctAttesters} counterparties
                </span>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </>
  )
}

/**
 * The hero's figure: one agent's standing, as the contract computes it.
 *
 * Real or nothing. When the registry read has landed it is the top agent's own
 * record; until then - and on a deployment with an empty registry, or a chain the
 * browser cannot reach - it is the neutral prior, which is a true statement about
 * an agent with no history rather than a placeholder dressed up as data. That is
 * why the chip says which of the two you are looking at, and why there are no
 * invented numbers in either case: `ScoreMeter` already explains a score of 50
 * with nothing behind it in its own words.
 */
function StandingPreview({ agent, policy }: { agent: AgentReport | null; policy: Policy }) {
  const report = agent?.report ?? null

  return (
    <aside className="hero__figure" aria-label="A reputation score as the contract computes it">
      <div className="standing">
        <div className="standing__head">
          <span className="standing__chip">
            {agent ? 'Live from the contract' : 'No history yet'}
          </span>
          {agent ? (
            <Link className="standing__addr mono" to={`/agents/${agent.address}`}>
              {shortAddress(agent.address)}
            </Link>
          ) : null}
        </div>

        <ScoreMeter
          scoreBp={report?.scoreBp ?? NEUTRAL_BP}
          counted={report?.nCounted ?? 0}
          size="hero"
          label="Reputation score"
        />

        <dl className="standing__rows">
          <div className="standing__row">
            <dt>Attestations counted</dt>
            <dd className="mono">{report ? formatCount(report.nCounted) : '—'}</dd>
          </div>
          <div className="standing__row">
            <dt>Distinct counterparties</dt>
            <dd className="mono">{report ? formatCount(report.nDistinctAttesters) : '—'}</dd>
          </div>
          <div className="standing__row">
            <dt>Weight half-life</dt>
            <dd className="mono">{formatDuration(policy.halfLifeSeconds)}</dd>
          </div>
          {/* The point of the whole system, on the fold: what this score costs
              its holder to take on work. Computed by the ported engine from the
              deployed policy, which is the same arithmetic `accept_engagement`
              runs before it will let the job start. */}
          <div className="standing__row">
            <dt>Collateral on a {formatBond(EXAMPLE_STAKE)} job</dt>
            <dd className="mono">
              {formatBond(
                collateralRequired(report?.scoreBp ?? NEUTRAL_BP, EXAMPLE_STAKE, policy),
              )}
            </dd>
          </div>
        </dl>

        <p className="standing__foot">
          {agent
            ? 'Read from the deployed contract and recomputed in your browser by a port pinned to the same engine.'
            : 'Nothing on this deployment carries weight yet. Fifty is the prior, not a verdict.'}
        </p>
      </div>
    </aside>
  )
}
