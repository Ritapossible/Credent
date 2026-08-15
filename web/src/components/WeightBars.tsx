import { useId, useState } from 'react'

import { bpToPercent, formatDuration, shortAddress } from '../core/format'
import type { GradedAttestation } from '../chain/registry'

interface Props {
  attestations: GradedAttestation[]
}

/**
 * Weight per attestation, as a horizontal bar chart.
 *
 * One series - how much each attestation counts - so it is one color (slot 1) and
 * needs no legend; the heading names what is plotted. Sorted by weight because
 * the reader's question is "which of these actually moved the score", and the
 * gated ones collect at the bottom at zero, which is the honest picture.
 *
 * Bars are laid out in HTML rather than SVG: they are a single stacked dimension
 * with text beside them, and HTML gives correct text wrapping and hit targets for
 * free.
 */
export default function WeightBars({ attestations }: Props) {
  const [showTable, setShowTable] = useState(false)
  const tableId = useId()

  const max = Math.max(1, ...attestations.map((entry) => entry.weight))
  const sorted = [...attestations].sort((a, b) => b.weight - a.weight)

  return (
    <div className="chart">
      <div className="chart__head">
        <div>
          <h3 className="chart__title">Weight carried by each attestation</h3>
          <p className="chart__sub muted">
            Basis points after substantiation floors, repeat damping, and decay. A full-strength
            fresh attestation is 10,000.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((open) => !open)}
        >
          {showTable ? 'Hide table' : 'Table view'}
        </button>
      </div>

      <ul className="bars">
        {sorted.map((entry) => {
          const pct = (entry.weight / max) * 100
          const gated = entry.weight === 0
          return (
            <li key={entry.id} className="bars__row">
              <div className="bars__label">
                <span className="bars__name mono" title={entry.attester}>
                  {shortAddress(entry.attester)}
                </span>
                <span className="bars__meta muted">
                  {formatDuration(entry.ageSeconds)} old
                  {entry.repeatIndex > 0 ? ` · repeat #${entry.repeatIndex + 1}` : ''}
                </span>
              </div>

              <div className="bars__track">
                {gated ? (
                  <span className="bars__gated">
                    Gated on {entry.breakdown.gatedBy === 'confidence' ? 'confidence' : 'evidence'}
                  </span>
                ) : (
                  <div className="bars__fill" style={{ width: `${Math.max(pct, 1.5)}%` }} />
                )}
              </div>

              <span className="bars__value">{entry.weight.toLocaleString('en-US')}</span>
            </li>
          )
        })}
      </ul>

      {showTable ? (
        <div className="table-wrap" id={tableId}>
          <table className="data-table">
            <caption className="visually-hidden">
              Weight, grade, and gating status for each attestation
            </caption>
            <thead>
              <tr>
                <th scope="col">Attester</th>
                <th scope="col">Age</th>
                <th scope="col">Repeat</th>
                <th scope="col">Substantiated</th>
                <th scope="col">Grade</th>
                <th scope="col">Weight</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row" className="mono">
                    {shortAddress(entry.attester)}
                  </th>
                  <td>{formatDuration(entry.ageSeconds)}</td>
                  <td>{entry.repeatIndex + 1}</td>
                  <td>{entry.substantiated}</td>
                  <td>{bpToPercent(entry.gradeBp, 0)}</td>
                  <td>{entry.weight.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
