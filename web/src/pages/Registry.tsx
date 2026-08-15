import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import ScoreMeter from '../components/ScoreMeter'
import ChainState from '../components/ChainState'
import { useRegistry } from '../chain/useOracle'
import { NETWORK } from '../chain/config'
import type { AgentReport } from '../chain/registry'
import { bpToPercent, formatCount, shortAddress } from '../core/format'

type SortKey = 'score' | 'attesters' | 'weight'

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'score', label: 'Score' },
  { key: 'attesters', label: 'Distinct attesters' },
  { key: 'weight', label: 'Total weight' },
]

export default function Registry() {
  const state = useRegistry()

  return (
    <div className="shell page">
      <div className="section-head">
        <p className="eyebrow eyebrow--pill">Registry</p>
        <h1>Agents with a graded history</h1>
        <p className="lede">
          Every agent here was attested about on {NETWORK}. The scores are the contract's own,
          read from <code className="mono">get_report</code> at page load.{' '}
          <Link to="/docs#recompute-not-read">How the score is derived →</Link>
        </p>
      </div>

      <ChainState state={state} what="the registry">
        {(registry) => <RegistryTable registry={registry} />}
      </ChainState>
    </div>
  )
}

function RegistryTable({ registry }: { registry: AgentReport[] }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('score')

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? registry.filter(
          (entry) =>
            entry.address.includes(needle) ||
            entry.attestations.some(
              (attestation) =>
                attestation.scope.toLowerCase().includes(needle) ||
                attestation.claim.toLowerCase().includes(needle),
            ),
        )
      : registry

    // Color and identity never depend on row order here - each card is its own
    // entity, so re-sorting cannot repaint anything.
    return [...filtered].sort((a, b) => {
      if (sort === 'attesters') return b.report.nDistinctAttesters - a.report.nDistinctAttesters
      if (sort === 'weight') return b.report.totalWeight - a.report.totalWeight
      return b.report.scoreBp - a.report.scoreBp
    })
  }, [registry, query, sort])

  if (registry.length === 0) {
    return (
      <div className="notice">
        <h3 className="notice__title">No attestations yet</h3>
        <p>
          The contract is deployed and reachable, and nobody has attested to an agent on it yet.
          The registry fills in as engagements close and counterparties attest.{' '}
          <Link to="/docs#protocol">How an attestation gets made →</Link>
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="filter-row">
        <div className="field filter-row__search">
          <label htmlFor="registry-search">Filter</label>
          <input
            id="registry-search"
            className="input"
            type="search"
            placeholder="Address, scope, or claim"
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
            <li key={entry.address}>
              <Link to={`/agents/${entry.address}`} className="agent-card">
                <div className="agent-card__head">
                  <div>
                    <h2 className="agent-card__name mono">{shortAddress(entry.address)}</h2>
                    <p className="muted agent-card__role">
                      {entry.report.nAttestations} attestation
                      {entry.report.nAttestations === 1 ? '' : 's'} on record
                    </p>
                  </div>
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
    </>
  )
}
