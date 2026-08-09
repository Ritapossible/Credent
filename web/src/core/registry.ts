/**
 * Derived view of the registry.
 *
 * The bridge between fixtures and the contract math: nothing in `pages/` computes
 * a weight or a score itself, so there is exactly one path from an attestation to
 * the number shown beside it.
 */

import { attestationWeight, explainWeight, type WeightBreakdown } from './scoring'
import { bondOutcome, bondRequired, type BondOutcome } from './bonding'
import { reportFor } from './simulate'
import { attestationSalt, scopeDigest } from './digest'
import { CREDENT_POLICY, type Policy } from './policy'
import { DEMO_AGENTS, type DemoAgent, type DemoAttestation } from './fixtures'
import type { Report } from './scoring'

export interface GradedAttestation extends DemoAttestation {
  weight: number
  breakdown: WeightBreakdown
  bond: bigint
  outcome: BondOutcome
  scopeDigest: string
  salt: string
}

export interface AgentReport {
  agent: DemoAgent
  report: Report
  attestations: GradedAttestation[]
  /** Share of total weight held by the single heaviest attester, in basis points. */
  concentrationBp: number
}

export function gradeAttestation(
  attestation: DemoAttestation,
  subject: string,
  policy: Policy,
): GradedAttestation {
  const input = {
    substantiated: attestation.substantiated,
    confidence: attestation.confidence,
    repeatIndex: attestation.repeatIndex,
    ageSeconds: attestation.ageSeconds,
    policy,
  }

  return {
    ...attestation,
    weight: attestationWeight(input),
    breakdown: explainWeight(input),
    bond: bondRequired(attestation.repeatIndex, policy),
    outcome: bondOutcome(
      { verdict: attestation.verdict, substantiated: attestation.substantiated },
      policy,
    ),
    scopeDigest: scopeDigest(attestation.scope),
    salt: attestationSalt({
      scope: attestation.scope,
      attester: attestation.attester,
      subject,
      claim: attestation.claim,
    }),
  }
}

export function buildReport(agent: DemoAgent, policy: Policy = CREDENT_POLICY): AgentReport {
  const attestations = agent.attestations.map((attestation) =>
    gradeAttestation(attestation, agent.address, policy),
  )

  const report = reportFor(
    attestations.map((entry) => ({
      weight: entry.weight,
      gradeBp: entry.gradeBp,
      attester: entry.attester,
    })),
    policy,
  )

  const byAttester = new Map<string, number>()
  for (const entry of attestations) {
    byAttester.set(entry.attester, (byAttester.get(entry.attester) ?? 0) + entry.weight)
  }
  const heaviest = Math.max(0, ...byAttester.values())
  const concentrationBp =
    report.totalWeight > 0 ? Math.floor((heaviest * 10_000) / report.totalWeight) : 0

  return { agent, report, attestations, concentrationBp }
}

export function buildRegistry(policy: Policy = CREDENT_POLICY): AgentReport[] {
  return DEMO_AGENTS.map((agent) => buildReport(agent, policy)).sort(
    (a, b) => b.report.scoreBp - a.report.scoreBp,
  )
}
