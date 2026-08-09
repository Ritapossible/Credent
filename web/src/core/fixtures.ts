/**
 * Demo dataset.
 *
 * The contract is not deployed yet, so the registry runs on fixtures. Ages are
 * stored as seconds-before-block-time rather than absolute dates: the contract
 * derives decay from `block_time - attested_at`, and holding the difference fixed
 * keeps every score on this site reproducible instead of drifting by the hour.
 *
 * Scores are never stored here. Every number the UI shows is computed from these
 * inputs through `core/scoring`, so the demo exercises the same path a validator
 * would.
 */

import type { Verdict } from './bonding'

const DAY = 86_400

export interface DemoAttestation {
  id: string
  attester: string
  attesterLabel: string
  /** Seconds between the attestation and the block time being reported at. */
  ageSeconds: number
  /** Which attestation this is from this attester about this subject, 0-indexed. */
  repeatIndex: number
  verdict: Verdict
  /** The model's grade of the engagement outcome, in basis points. */
  gradeBp: number
  /** How well the attestation's claims were supported, 0–100. */
  substantiated: number
  /** The model's certainty about its own reading, 0–100. */
  confidence: number
  scope: string
  claim: string
}

export interface DemoAgent {
  address: string
  name: string
  role: string
  summary: string
  attestations: DemoAttestation[]
}

export const DEMO_AGENTS: DemoAgent[] = [
  {
    address: '0x7a3f9c2e5b8d1a4f6c0e9b2d7a5f3c1e8b6d4a29',
    name: 'Meridian',
    role: 'Settlement routing',
    summary:
      'Routes stablecoin settlement across three chains for mid-size treasuries. Long history, steady grades, one disputed engagement that resolved in its favour.',
    attestations: [
      {
        id: 'mer-1',
        attester: '0xc41d8e7b2a9f5c3e1d6b8a4f2c7e9d5b3a1f8c62',
        attesterLabel: 'Northwind Treasury',
        ageSeconds: 6 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 9200,
        substantiated: 88,
        confidence: 91,
        scope:
          'Route 2.4M USDC from Base to Arbitrum within 40 minutes, total slippage under 8bp, no single venue above 60% of volume.',
        claim:
          'Completed in 31 minutes at 5.1bp total slippage. Venue split 44/33/23. Full fill logs shared.',
      },
      {
        id: 'mer-2',
        attester: '0x2e9b5a1f7c4d8e3b6a0f9c2d5e8b4a7f1c3d6e90',
        attesterLabel: 'Halden Capital',
        ageSeconds: 24 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 8800,
        substantiated: 79,
        confidence: 84,
        scope: 'Weekly rebalance, 800k notional, execution within 15bp of arrival price.',
        claim: 'Eleven of twelve weeks inside tolerance. Week nine missed at 19bp during a depeg.',
      },
      {
        id: 'mer-3',
        attester: '0xc41d8e7b2a9f5c3e1d6b8a4f2c7e9d5b3a1f8c62',
        attesterLabel: 'Northwind Treasury',
        ageSeconds: 58 * DAY,
        repeatIndex: 1,
        verdict: 'fulfilled',
        gradeBp: 9000,
        substantiated: 81,
        confidence: 86,
        scope: 'Route 1.1M USDC Base to Optimism, slippage under 10bp.',
        claim: 'Completed at 6.4bp. Logs shared.',
      },
      {
        id: 'mer-4',
        attester: '0x8f2c6d9a3e7b1f5c8d2a6e0b4f9c3d7a1e5b8c24',
        attesterLabel: 'Cedar Desk',
        ageSeconds: 96 * DAY,
        repeatIndex: 0,
        verdict: 'partial',
        gradeBp: 6100,
        substantiated: 72,
        confidence: 77,
        scope: 'Unwind a 3.2M position across 6 hours without moving mid more than 25bp.',
        claim:
          'Unwound 2.7M inside tolerance, held 500k back citing thin books. Client wanted the full unwind.',
      },
      {
        id: 'mer-5',
        attester: '0x5b1e8a4f2c9d7e3b6a0f8c1d5e2b9a4f7c3d6e18',
        attesterLabel: 'Pell & Roe',
        ageSeconds: 210 * DAY,
        repeatIndex: 0,
        verdict: 'unfulfilled',
        gradeBp: 2400,
        substantiated: 31,
        confidence: 58,
        scope: 'Maintain a 24/7 quote on two pairs with 95% uptime over one month.',
        claim:
          'Client reports 71% uptime. Agent disputes, citing an RPC outage on the client side. Neither party produced logs covering the gap.',
      },
    ],
  },
  {
    address: '0x1c8d5f3a9e2b7c4d6f0a8e5b3c1d9f7a2e6b4c80',
    name: 'Ostrich',
    role: 'Research synthesis',
    summary:
      'Newer agent, three engagements, all well-substantiated. The prior still dominates: strong grades on thin history read as promising, not proven.',
    attestations: [
      {
        id: 'ost-1',
        attester: '0x9d4a7c2e5f8b1d6a3e0c9f5b2d8a4e7c1f3b6d52',
        attesterLabel: 'Lumen Labs',
        ageSeconds: 3 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 9600,
        substantiated: 93,
        confidence: 89,
        scope:
          'Survey 40 papers on retrieval-augmented eval, produce a contradiction table with citations.',
        claim: 'Delivered 44 papers, 19 contradictions, every claim traceable to a page number.',
      },
      {
        id: 'ost-2',
        attester: '0x4f7b2d9a6c3e1f8b5d0a7c4e2b9f6a3d8c1e5b74',
        attesterLabel: 'Verity Group',
        ageSeconds: 17 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 9100,
        substantiated: 85,
        confidence: 88,
        scope: 'Reproduce the headline figure from three preprints, flag any that fail.',
        claim: 'Two reproduced within tolerance. One failed; agent supplied the diff and the seed.',
      },
      {
        id: 'ost-3',
        attester: '0x6a3e9c1f5b8d2a7e4c0f6b3d9a5e2c8f1b4d7a36',
        attesterLabel: 'Ashby Institute',
        ageSeconds: 41 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 8900,
        substantiated: 82,
        confidence: 80,
        scope: 'Build an annotated bibliography on consensus-safe LLM inference, 25 sources.',
        claim: 'Delivered 25 annotated sources. Client noted two were tangential.',
      },
    ],
  },
  {
    address: '0x3e7a1d9f4c8b2e6a5d0c7f3b9e1a4d8c2f6b5e70',
    name: 'Kestrel',
    role: 'Data pipeline ops',
    summary:
      'High volume from a narrow set of counterparties. Repeat damping does most of the work here: forty attestations, but few independent voices behind them.',
    attestations: [
      {
        id: 'kes-1',
        attester: '0xb8e2c5a9f1d7b3e6a4c0d8f2b5e9a3c7f1d6b4e2',
        attesterLabel: 'Sable Systems',
        ageSeconds: 2 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 8600,
        substantiated: 76,
        confidence: 82,
        scope: 'Nightly ETL across 14 sources, complete by 06:00 UTC, zero silent row drops.',
        claim: 'Thirty consecutive nights on time. Row counts reconciled each morning.',
      },
      {
        id: 'kes-2',
        attester: '0xb8e2c5a9f1d7b3e6a4c0d8f2b5e9a3c7f1d6b4e2',
        attesterLabel: 'Sable Systems',
        ageSeconds: 9 * DAY,
        repeatIndex: 1,
        verdict: 'fulfilled',
        gradeBp: 8700,
        substantiated: 78,
        confidence: 83,
        scope: 'Same nightly ETL, following month.',
        claim: 'Twenty-nine of thirty-one nights on time. Two late by under 20 minutes.',
      },
      {
        id: 'kes-3',
        attester: '0xb8e2c5a9f1d7b3e6a4c0d8f2b5e9a3c7f1d6b4e2',
        attesterLabel: 'Sable Systems',
        ageSeconds: 16 * DAY,
        repeatIndex: 2,
        verdict: 'fulfilled',
        gradeBp: 8500,
        substantiated: 74,
        confidence: 81,
        scope: 'Same nightly ETL, following month.',
        claim: 'On time throughout. One schema change absorbed without intervention.',
      },
      {
        id: 'kes-4',
        attester: '0xb8e2c5a9f1d7b3e6a4c0d8f2b5e9a3c7f1d6b4e2',
        attesterLabel: 'Sable Systems',
        ageSeconds: 23 * DAY,
        repeatIndex: 3,
        verdict: 'fulfilled',
        gradeBp: 8800,
        substantiated: 80,
        confidence: 84,
        scope: 'Same nightly ETL, following month.',
        claim: 'On time throughout.',
      },
      {
        id: 'kes-5',
        attester: '0x7c4f1a8d2e5b9c3f6a0d7e4b1c8f5a2d9e6b3c48',
        attesterLabel: 'Ridge Analytics',
        ageSeconds: 34 * DAY,
        repeatIndex: 0,
        verdict: 'partial',
        gradeBp: 5800,
        substantiated: 69,
        confidence: 74,
        scope: 'Backfill 18 months of event data with under 0.1% loss.',
        claim: 'Backfilled 18 months at 0.4% loss, attributed to an upstream retention window.',
      },
      {
        id: 'kes-6',
        attester: '0xd1b7e4a2c9f5d8b3e6a1c4f7b2d9e5a8c3f6b1d4',
        attesterLabel: 'Tolan Freight',
        ageSeconds: 140 * DAY,
        repeatIndex: 0,
        verdict: 'ungraded',
        gradeBp: 5000,
        substantiated: 12,
        confidence: 34,
        scope: 'Integrate a partner feed and alert on schema drift.',
        claim: 'Attestation text was largely a link to a private dashboard with no readable detail.',
      },
    ],
  },
  {
    address: '0x9f5c2a7e1b4d8f3c6a0e9b5d2c7f4a1e8b3d6c95',
    name: 'Tamarind',
    role: 'Contract review',
    summary:
      'One glowing attestation and nothing else. The neutral prior is why this reads as unproven rather than excellent — a single voice cannot mint a reputation.',
    attestations: [
      {
        id: 'tam-1',
        attester: '0x2a8f5c1e9b6d3a7f4c0e8b2d5a9f6c3e1b7d4a80',
        attesterLabel: 'Copperline',
        ageSeconds: 5 * DAY,
        repeatIndex: 0,
        verdict: 'fulfilled',
        gradeBp: 9900,
        substantiated: 95,
        confidence: 93,
        scope: 'Review a vault contract for reentrancy and rounding loss, report within 72 hours.',
        claim:
          'Delivered in 51 hours. Two rounding findings confirmed by a second reviewer, both fixed.',
      },
    ],
  },
]

export function findAgent(address: string): DemoAgent | undefined {
  const needle = address.trim().toLowerCase()
  return DEMO_AGENTS.find((agent) => agent.address.toLowerCase() === needle)
}
