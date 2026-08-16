import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import LineChart, { type Series } from '../components/LineChart'
import StatTile from '../components/StatTile'
import { rangeFill } from '../components/rangeFill'
import { useEffectivePolicy } from '../chain/useOracle'
import { costCurve, repeatPath, repeatPenalty, sybilFleetPath } from '../core/simulate'
import {
  NATIVE_DECIMALS,
  NATIVE_SYMBOL,
  bpToScore,
  formatBond,
  formatCount,
  formatUnits,
} from '../core/format'

export default function AttackCost() {
  const [targetScore, setTargetScore] = useState(85)
  const [gradeScore, setGradeScore] = useState(100)

  // Every figure on this page is a cost, and a cost quoted from a constant is a
  // claim about a deployment nobody checked. The page previously computed its
  // entire argument from `CREDENT_POLICY` while the deployment of the day
  // carried `min_bond = 0` - which makes all of it free, not expensive. The
  // current studionet deployment charges 1 GEN, which is exactly why this is
  // read rather than assumed: both numbers have been live at some point.
  const { policy, live } = useEffectivePolicy()
  const penalty = repeatPenalty(policy)
  const free = policy.minBond === 0n

  const targetBp = targetScore * 100
  const gradeBp = gradeScore * 100

  const fleet = sybilFleetPath(targetBp, gradeBp, policy)
  const repeat = repeatPath(targetBp, gradeBp, policy)
  const curve = useMemo(() => costCurve(gradeBp, policy), [gradeBp, policy])

  /**
   * Two series - the two shapes an attack can take - so a legend is required and
   * both get direct comparison in the table below. One y-axis in GEN for both:
   * they are the same measure, which is exactly why they belong on one plot.
   */
  const series: Series[] = useMemo(
    () => [
      {
        key: 'fleet',
        label: 'Fresh attester each time',
        color: '--series-1',
        points: curve.map((point) => ({
          x: point.targetBp,
          y: Number(formatRaw(point.fleetBond)),
        })),
      },
      {
        key: 'repeat',
        label: 'One attester, repeating',
        color: '--series-2',
        points: curve.map((point) => ({
          x: point.targetBp,
          y: Number(formatRaw(point.repeatBond)),
        })),
      },
    ],
    [curve],
  )

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Attack cost</p>
        <h1>What it costs to buy a score</h1>
        <p className="lede">
          Weight halves on every repeat from the same counterparty while the bond doubles, so cost
          per unit of weight rises as the square. Every figure comes from the same{' '}
          <code>aggregate</code> and <code>bondRequired</code> the contract uses.{' '}
          <Link to="/docs#volume-is-not-standing">Why the curves oppose →</Link>
        </p>
      </div>

      {/* A cost page has one way to mislead badly, and this is it: quoting a
          price the deployment does not charge. Both states are stated plainly
          rather than left to the reader to infer from a zero. */}
      {free ? (
        <div className="notice notice--critical">
          <h2 className="notice__title">This deployment charges no bond</h2>
          <p>
            The contract this build reads runs with <code className="mono">min_bond = 0</code>, so
            every attestation is free and the costs below are <strong>not</strong> being enforced.
            They describe the defence as designed, not as deployed. Treat scores here as
            unprotected against sybil attestation.
          </p>
        </div>
      ) : null}

      {!live && !free ? (
        <div className="notice notice--warning">
          <h2 className="notice__title">Costs shown from intended parameters</h2>
          <p>
            The deployed policy could not be read, so these figures use this repository's intended
            configuration rather than the live contract's.
          </p>
        </div>
      ) : null}

      <div className="filter-row">
        <div className="field">
          <div className="field__row">
            <label htmlFor="target">Target score</label>
            <output htmlFor="target" className="field__output">
              {targetScore}
            </output>
          </div>
          <input
            id="target"
            className="range"
            type="range"
            min={51}
            max={98}
            value={targetScore}
            style={rangeFill(targetScore, 51, 98)}
            onChange={(event) => setTargetScore(Number(event.target.value))}
          />
          <p className="hint">Where the attacker wants the agent to land.</p>
        </div>

        <div className="field">
          <div className="field__row">
            <label htmlFor="grade">Grade per attestation</label>
            <output htmlFor="grade" className="field__output">
              {gradeScore}
            </output>
          </div>
          <input
            id="grade"
            className="range"
            type="range"
            min={60}
            max={100}
            value={gradeScore}
            style={rangeFill(gradeScore, 60, 100)}
            onChange={(event) => setGradeScore(Number(event.target.value))}
          />
          <p className="hint">
            The best grade the attacker can manufacture. A target at or above this is unreachable at
            any price.
          </p>
        </div>
      </div>

      <section className="kpi-row" aria-label="Cost to reach the target">
        <StatTile
          label="Fresh attesters needed"
          value={fleet.count === null ? 'Unreachable' : formatCount(fleet.count)}
          note={fleet.count === null ? 'Target is at or above the grade' : 'Each posts one bond'}
        />
        <StatTile
          label="Total bond, fresh attesters"
          value={fleet.count === null ? '-' : formatBond(fleet.totalBond)}
          note="The cheapest shape available"
        />
        <StatTile
          label="Total bond, one attester"
          value={repeat.count === null ? 'Unreachable' : formatBond(repeat.totalBond)}
          note={
            repeat.count === null
              ? 'Cannot get there'
              : `${formatCount(repeat.count)} attestations, doubling`
          }
        />
        <StatTile
          label="Repeat penalty at the cap"
          value={`${formatCount(Math.round(penalty))}×`}
          note="Cost per unit of weight"
        />
      </section>

      <section className="band">
        <div className="section-head">
          <p className="eyebrow">Cost curve</p>
          <h2>Bond required, by target score</h2>
          <p className="muted">
            Both series are {NATIVE_SYMBOL} posted, so they share one axis. The repeat path climbs
            away because each attestation buys half as much weight as the one before while costing
            twice as much.
          </p>
        </div>

        <LineChart
          series={series}
          xLabel="Target score"
          yLabel={`Total bond in ${NATIVE_SYMBOL}`}
          formatX={(value) => bpToScore(value, 0)}
          formatY={(value) => compactUnits(value)}
          height={320}
        />

        <div className="table-wrap band__table">
          <table className="data-table">
            <caption className="visually-hidden">
              Attestations and total bond required for each target score, by attack shape
            </caption>
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Fresh attesters</th>
                <th scope="col">Bond (fresh)</th>
                <th scope="col">Repeat count</th>
                <th scope="col">Bond (repeat)</th>
              </tr>
            </thead>
            <tbody>
              {curve.map((point) => (
                <tr key={point.targetBp}>
                  <th scope="row">{bpToScore(point.targetBp, 1)}</th>
                  <td>{point.fleetCount === null ? '-' : formatCount(point.fleetCount)}</td>
                  <td>{point.fleetCount === null ? '-' : formatUnits(point.fleetBond)}</td>
                  <td>{point.repeatCount === null ? '-' : formatCount(point.repeatCount)}</td>
                  <td>{point.repeatCount === null ? '-' : formatUnits(point.repeatBond)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="band">
        <div className="notice">
          <h3 className="notice__title">What this does and does not defend against</h3>
          <p>
            The bond curve makes <em>repetition</em> expensive, not attestation - a fresh attester
            always pays the flat first bond. What stops a sybil fleet is the engagement
            requirement, not the price.{' '}
            <Link to="/docs#attack-surface">What actually stops the fleet →</Link>
          </p>
        </div>
      </section>
    </div>
  )
}

/**
 * Bond base units as a plain number of whole tokens, for plotting.
 *
 * The scale comes from `NATIVE_DECIMALS` rather than a literal, because the
 * literal here was `1_000_000n` - six decimals, for a token the contract never
 * charged - and every point on this chart inherited the error.
 */
function formatRaw(value: bigint): string {
  return (value / 10n ** NATIVE_DECIMALS).toString()
}

function compactUnits(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return value.toFixed(0)
}
