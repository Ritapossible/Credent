import { Link } from 'react-router-dom'

import StatTile from '../components/StatTile'
import { buildRegistry } from '../core/registry'
import { CREDENT_POLICY } from '../core/policy'
import { repeatPenalty } from '../core/simulate'
import { bpToScore, formatBond, formatCount, formatDuration } from '../core/format'

const registry = buildRegistry()
const penalty = repeatPenalty(CREDENT_POLICY)

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
  const strongest = registry[0]

  return (
    <>
      <section className="hero">
        <div className="shell hero__inner">
          <p className="eyebrow eyebrow--pill">Reputation-backed trust infrastructure</p>
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
      </section>

      <div className="shell page">
        <section className="kpi-row" aria-label="Deployed parameters">
          <StatTile
            label="Attestation half-life"
            value={formatDuration(CREDENT_POLICY.halfLifeSeconds)}
            note="Weight halves at this age"
          />
          <StatTile
            label="Neutral prior"
            value={`${CREDENT_POLICY.priorWeight.toLocaleString('en-US')} bp`}
            note="Three full attestations of inertia"
          />
          <StatTile
            label="First-attestation bond"
            value={formatBond(CREDENT_POLICY.minBond)}
            note="Doubles on every repeat"
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
                <h3 className="feature__name">{strongest.agent.name}</h3>
                <p className="muted feature__role">{strongest.agent.role}</p>
                <p className="muted">{strongest.agent.summary}</p>
                <Link className="btn btn--ghost" to={`/agents/${strongest.agent.address}`}>
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
