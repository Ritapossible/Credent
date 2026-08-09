import { BAND_LABEL, bpToScore, scoreBand } from '../core/format'

interface Props {
  scoreBp: number
  /** Attestations that carried weight. A score with nothing behind it is stated as such. */
  counted: number
  size?: 'hero' | 'inline'
  label?: string
}

/**
 * Score as a meter, not a chart.
 *
 * A single ratio against a fixed range is a meter — a one-bar bar chart would
 * carry the same number with axes and gridlines around it. The track is a lighter
 * step of the fill's own ramp so the unfilled portion still reads as part of the
 * scale, and the neutral marker shows where "no history" sits, which is the whole
 * reason 50 is not the bottom of the bar.
 */
export default function ScoreMeter({ scoreBp, counted, size = 'inline', label }: Props) {
  const band = scoreBand(scoreBp)
  const pct = Math.max(0, Math.min(100, scoreBp / 100))

  return (
    <div className={`meter meter--${size}`}>
      <div className="meter__head">
        {label ? <span className="meter__label">{label}</span> : null}
        <span className={`meter__value meter__value--${size}`}>{bpToScore(scoreBp)}</span>
        <span className={`badge badge--${band}`}>{BAND_LABEL[band]}</span>
      </div>

      <div
        className="meter__track"
        role="meter"
        aria-valuenow={Number(bpToScore(scoreBp))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Reputation score'}
      >
        <div className={`meter__fill meter__fill--${band}`} style={{ width: `${pct}%` }} />
        <div className="meter__neutral" style={{ left: '50%' }} aria-hidden="true" />
      </div>

      <div className="meter__foot">
        <span className="muted">0</span>
        <span className="meter__neutral-note">50 · no history</span>
        <span className="muted">100</span>
      </div>

      {counted === 0 ? (
        <p className="meter__note">
          No attestation carries weight. This is the neutral prior showing through, not a verdict.
        </p>
      ) : null}
    </div>
  )
}
