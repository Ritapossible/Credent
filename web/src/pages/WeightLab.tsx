import { useMemo, useState } from 'react'

import LineChart, { type Series } from '../components/LineChart'
import StatTile from '../components/StatTile'
import { attestationWeight, explainWeight, decayBp } from '../core/scoring'
import { bondRequired } from '../core/bonding'
import { CREDENT_POLICY } from '../core/policy'
import { bpToPercent, formatBond, formatDuration } from '../core/format'

const DAY = 86_400
const policy = CREDENT_POLICY

export default function WeightLab() {
  const [substantiated, setSubstantiated] = useState(80)
  const [confidence, setConfidence] = useState(85)
  const [repeatIndex, setRepeatIndex] = useState(0)
  const [ageDays, setAgeDays] = useState(30)

  const input = {
    substantiated,
    confidence,
    repeatIndex,
    ageSeconds: ageDays * DAY,
    policy,
  }

  const weight = attestationWeight(input)
  const breakdown = explainWeight(input)
  const bond = bondRequired(repeatIndex, policy)

  /**
   * Decay of *this* attestation's post-damping weight over time. One series, so
   * one hue and no legend — the title says what is plotted. The current age rides
   * along as the marker.
   */
  const decaySeries: Series[] = useMemo(() => {
    const points = Array.from({ length: 37 }, (_, i) => {
      const days = i * 10
      return {
        x: days,
        y: decayBp(breakdown.afterRepeat, days * DAY, policy.halfLifeSeconds),
      }
    })
    return [{ key: 'decay', label: 'Weight', color: '--series-1', points }]
  }, [breakdown.afterRepeat])

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow">Weight lab</p>
        <h1>What one attestation is worth</h1>
        <p className="lede">
          Move the inputs and watch the same four steps the contract runs: floors, then
          substantiation, then repeat damping, then decay. Confidence gates but never scales — it is
          the model's certainty about its own reading, so letting it scale would make the score
          track hesitancy as much as evidence.
        </p>
      </div>

      <div className="lab">
        <form className="lab__controls card" onSubmit={(event) => event.preventDefault()}>
          <Slider
            id="substantiated"
            label="Substantiated"
            hint={`How well the claim was supported. Floor is ${policy.minSubstantiated}.`}
            min={0}
            max={100}
            value={substantiated}
            onChange={setSubstantiated}
            display={`${substantiated} / 100`}
          />
          <Slider
            id="confidence"
            label="Confidence"
            hint={`The model's certainty about its reading. Floor is ${policy.minConfidence}.`}
            min={0}
            max={100}
            value={confidence}
            onChange={setConfidence}
            display={`${confidence} / 100`}
          />
          <Slider
            id="repeat"
            label="Repeat index"
            hint={`Which attestation this is from the same counterparty. Damping caps at ${policy.repeatShiftCap}.`}
            min={0}
            max={10}
            value={repeatIndex}
            onChange={setRepeatIndex}
            display={repeatIndex === 0 ? 'First' : `#${repeatIndex + 1}`}
          />
          <Slider
            id="age"
            label="Age"
            hint={`Half-life is ${formatDuration(policy.halfLifeSeconds)}.`}
            min={0}
            max={365}
            value={ageDays}
            onChange={setAgeDays}
            display={formatDuration(ageDays * DAY)}
          />
        </form>

        <div className="lab__result">
          <div className="kpi-row kpi-row--tight">
            <StatTile
              label="Weight carried"
              value={weight.toLocaleString('en-US')}
              note="Basis points, out of 10,000"
            />
            <StatTile
              label="Bond required"
              value={formatBond(bond)}
              note={repeatIndex === 0 ? 'First attestation' : `Doubled ${Math.min(repeatIndex, policy.repeatShiftCap)}×`}
            />
          </div>

          {breakdown.gatedBy ? (
            <div className="notice notice--warning">
              <h3 className="notice__title">
                Gated on {breakdown.gatedBy === 'confidence' ? 'confidence' : 'substantiation'}
              </h3>
              <p>
                {breakdown.gatedBy === 'confidence'
                  ? `Confidence ${confidence} is below the floor of ${policy.minConfidence}.`
                  : `Substantiation ${substantiated} is below the floor of ${policy.minSubstantiated}.`}{' '}
                The attestation contributes nothing at all — not a reduced weight, zero. Below the
                floor the reading is not reliable enough to be worth partial credit.
              </p>
            </div>
          ) : (
            <ol className="derivation derivation--lab">
              <li>
                <span>Base from substantiation</span>
                <strong>{breakdown.base.toLocaleString('en-US')}</strong>
              </li>
              <li>
                <span>
                  After repeat damping
                  {breakdown.repeatShiftBits > 0
                    ? ` (halved ${breakdown.repeatShiftBits}×)`
                    : ' (undamped)'}
                </span>
                <strong>{breakdown.afterRepeat.toLocaleString('en-US')}</strong>
              </li>
              <li>
                <span>After decay</span>
                <strong>{breakdown.weight.toLocaleString('en-US')}</strong>
              </li>
              <li className="derivation__loss">
                <span>Lost to decay</span>
                <strong>−{breakdown.decayLossBp.toLocaleString('en-US')}</strong>
              </li>
            </ol>
          )}
        </div>
      </div>

      <section className="band">
        <div className="section-head">
          <p className="eyebrow">Decay</p>
          <h2>How this attestation fades</h2>
          <p className="muted">
            Whole half-lives are a bit shift; the remainder is linearly interpolated between
            neighbouring halvings. That makes the curve a ramp rather than a staircase an agent
            could time a submission around.
          </p>
        </div>

        <LineChart
          series={decaySeries}
          xLabel="Age in days"
          yLabel="Weight in basis points"
          formatX={(value) => `${value}d`}
          formatY={(value) => Math.round(value).toLocaleString('en-US')}
          marker={{ y: weight, label: `now: ${weight.toLocaleString('en-US')}` }}
        />
      </section>

      <section className="band">
        <div className="notice">
          <h3 className="notice__title">Why confidence gates instead of scaling</h3>
          <p>
            Substantiation is a judgement about the <em>evidence</em>; confidence is a judgement
            about the <em>judgement</em>. Multiplying weight by confidence would blend the two and
            let a hesitant-but-correct reading quietly count for less than a certain-but-shakier
            one. A floor keeps the two separable: below it the reading is discarded, above it the
            evidence speaks for itself. Gated attestations still show up at{' '}
            {bpToPercent(0, 0)} weight rather than disappearing.
          </p>
        </div>
      </section>
    </div>
  )
}

interface SliderProps {
  id: string
  label: string
  hint: string
  min: number
  max: number
  value: number
  display: string
  onChange: (value: number) => void
}

function Slider({ id, label, hint, min, max, value, display, onChange }: SliderProps) {
  return (
    <div className="field">
      <div className="field__row">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="field__output">
          {display}
        </output>
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="hint">{hint}</p>
    </div>
  )
}
