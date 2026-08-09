import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import ScoreMeter from '../components/ScoreMeter'
import { buildRegistry } from '../core/registry'
import { bpToPercent, formatCount, shortAddress } from '../core/format'

const registry = buildRegistry()

type SortKey = 'score' | 'attesters' | 'weight'

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'score', label: 'Score' },
  { key: 'attesters', label: 'Distinct attesters' },
  { key: 'weight', label: 'Total weight' },
]

export default function Registry() {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('score')

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? registry.filter(
          (entry) =>
            entry.agent.name.toLowerCase().includes(needle) ||
            entry.agent.role.toLowerCase().includes(needle) ||
            entry.agent.address.toLowerCase().includes(needle),
        )
      : registry

    // Color and identity never depend on row order here — each card is its own
    // entity, so re-sorting cannot repaint anything.
    return [...filtered].sort((a, b) => {
      if (sort === 'attesters') return b.report.nDistinctAttesters - a.report.nDistinctAttesters
      if (sort === 'weight') return b.report.totalWeight - a.report.totalWeight
      return b.report.scoreBp - a.report.scoreBp
    })
  }, [query, sort])

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow">Registry</p>
        <h1>Agents with a graded history</h1>
        <p className="lede">
          Every score below is computed in your browser from the fixture attestations, using the same
          integer arithmetic the contract runs. Sorting and filtering change nothing about how a
          score was derived.
        </p>
      </div>

      <div className="filter-row">
        <div className="field filter-row__search">
          <label htmlFor="registry-search">Filter</label>
          <input
            id="registry-search"
            className="input"
            type="search"
            placeholder="Name, role, or address"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <fieldset className="segmented">
          <legend className="segmented__legend">Sort by</legend>
          {SORTS.map((option) => (
            <label key={option.key} className="segmented__option">
              <input
                type="radio"
                name="registry-sort"
                value={option.key}
                checked={sort === option.key}
                onChange={() => setSort(option.key)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      </div>

      {rows.length === 0 ? (
        <p className="empty muted">No agent matches “{query}”.</p>
      ) : (
        <ul className="agent-list">
          {rows.map((entry) => (
            <li key={entry.agent.address}>
              <Link to={`/agents/${entry.agent.address}`} className="agent-card">
                <div className="agent-card__head">
                  <div>
                    <h2 className="agent-card__name">{entry.agent.name}</h2>
                    <p className="muted agent-card__role">{entry.agent.role}</p>
                  </div>
                  <span className="mono agent-card__address" title={entry.agent.address}>
                    {shortAddress(entry.agent.address)}
                  </span>
                </div>

                <ScoreMeter
                  scoreBp={entry.report.scoreBp}
                  counted={entry.report.nCounted}
                  label="Reputation"
                />

                <dl className="agent-card__facts">
                  <div>
                    <dt>Counted</dt>
                    <dd>
                      {entry.report.nCounted} of {entry.report.nAttestations}
                    </dd>
                  </div>
                  <div>
                    <dt>Attesters</dt>
                    <dd>{entry.report.nDistinctAttesters}</dd>
                  </div>
                  <div>
                    <dt>Total weight</dt>
                    <dd>{formatCount(entry.report.totalWeight)}</dd>
                  </div>
                  <div>
                    <dt>Top attester share</dt>
                    <dd>{bpToPercent(entry.concentrationBp, 0)}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
