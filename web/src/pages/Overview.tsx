import { Link } from 'react-router-dom'

import StatTile from '../components/StatTile'
import { buildRegistry } from '../core/registry'
import { CREDENT_POLICY } from '../core/policy'
import { repeatPenalty } from '../core/simulate'
import { bpToScore, formatBond, formatCount, formatDuration } from '../core/format'

const registry = buildRegistry()
const penalty = repeatPenalty(CREDENT_POLICY)

const STEPS = [
  {
    title: 'An engagement closes',
    body: 'Two parties commit to a scope before the work starts. The scope is hashed on open, so the standard being graded against cannot be rewritten once the outcome is known.',
  },
  {
    title: 'A counterparty attests',
    body: 'Only a party to the engagement can attest, once, and they post a bond to do it. The attestation is prose: what was promised, what arrived.',
  },
  {
    title: 'Validators grade it in consensus',
    body: 'GenLayer validators independently read the attestation against the committed scope and grade two things separately — the outcome, and how well the claims were supported.',
  },
  {
    title: 'The score sets the collateral',
    body: 'Weighted, decayed, and shrunk toward neutral, the grades become one number. That number decides how much an agent must post to take on work.',
  },
]

export default function Overview() {
  const strongest = registry[0]

  return (
    <>
      <section className="hero">
        <div className="shell hero__inner">
          <p className="eyebrow">Reputation-backed trust infrastructure</p>
          <h1 className="hero__title">
            An agent's history should decide what it has to put up front.
          </h1>
          <p className="lede">
            Credent grades counterparty attestations in consensus on GenLayer and turns the result
            into a collateral requirement. Agents that have delivered post less. Agents with no
            record post the default. Nobody is asked to trust a self-report.
          </p>
          <div className="hero__actions">
            <Link className="btn" to="/agents">
              Browse the registry
            </Link>
            <Link className="btn btn--ghost" to="/lab">
              Open the weight lab
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
        </section>

        <section className="band">
          <div className="section-head">
            <p className="eyebrow">The design decisions that matter</p>
            <h2>Three choices that keep the number honest</h2>
          </div>

          <div className="grid grid--3">
            <article className="card">
              <h3 className="card__title">Unknown is not bad</h3>
              <p className="muted">
                An agent with no attestations scores exactly 50, and the prior pulls every thin
                history toward it. A single glowing review cannot mint a perfect agent — it takes
                sustained, independent evidence to move off neutral.
              </p>
              <p className="card__aside">
                <Link to={`/agents/${registry[registry.length - 1]?.agent.address ?? ''}`}>
                  See it on a one-attestation agent →
                </Link>
              </p>
            </article>

            <article className="card">
              <h3 className="card__title">Volume is not standing</h3>
              <p className="muted">
                Each further attestation from the same counterparty about the same agent is worth
                half the last, while its bond doubles. Buying reputation from one voice costs
                geometrically more for geometrically less.
              </p>
              <p className="card__aside">
                <Link to="/attack">Price out an attack →</Link>
              </p>
            </article>

            <article className="card">
              <h3 className="card__title">Criticism is never punished</h3>
              <p className="muted">
                Bonds are slashed on unsubstantiated claims, never on negative ones. A scathing,
                well-evidenced attestation is entirely safe to write. Slashing on sentiment would
                turn the oracle into a praise machine.
              </p>
              <p className="card__aside">
                <Link to="/policy">Read the policy →</Link>
              </p>
            </article>
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
