/**
 * The registry, assembled from chain reads.
 *
 * This is the file that used to be a fixture list. Everything it returns now
 * comes from `@gl.public.view` calls against the deployed contract, and the
 * numbers beside each attestation are the contract's own - `get_attestation`
 * reports the weight it computed, and `get_report` the score it aggregated.
 *
 * The ported math in `core/` is still used, for one thing only: the *breakdown*
 * that explains how a weight was reached. The contract returns the weight but
 * not its decomposition, so the decay and repeat factors shown in the UI are
 * recomputed locally. That is safe precisely because it is pinned - the parity
 * vectors fail the build if the port and the engine ever disagree - and the
 * recomputed total is checked against the chain's below rather than assumed.
 *
 * ## On enumeration
 *
 * The contract indexes attestations by subject, not subjects by themselves:
 * there is no `list_subjects` view, because maintaining one would mean an
 * unbounded array written on every attestation for the benefit of clients only.
 * So the registry is derived the way an indexer would derive it - walk every
 * attestation once, group by subject - which is `attestation_count()` reads.
 * That is fine at the scale this contract operates at and would want a real
 * indexer past a few thousand; the boundary is documented rather than hidden.
 */

import { bondOutcome, type BondOutcome } from '../core/bonding'
import { attestationSalt, scopeDigest } from '../core/digest'
import { type Policy } from '../core/policy'
import { explainWeight, type Report, type WeightBreakdown } from '../core/scoring'
import { reportFor } from '../core/simulate'
import {
  attestationCount,
  getAttestation,
  getEngagement,
  getPolicy,
  getReport,
  getSubjectAttestations,
  type ChainAttestation,
} from './oracle'

export interface GradedAttestation extends ChainAttestation {
  /** How the weight decomposes, recomputed locally from the pinned port. */
  breakdown: WeightBreakdown
  outcome: BondOutcome
  /** The engagement's committed scope text, resolved through `get_engagement`. */
  scope: string
  /** Digest of that scope, recomputed to show it matches what was committed. */
  scopeDigestHex: string
  salt: string
}

export interface AgentReport {
  address: string
  report: Report
  attestations: GradedAttestation[]
  /** Share of total weight held by the single heaviest attester, in basis points. */
  concentrationBp: number
  /** The deployed parameters these numbers were produced under. */
  policy: Policy
}

/**
 * Bounded concurrency over chain reads.
 *
 * Firing every read at once is the obvious spelling and the one that gets a
 * public RPC to start refusing connections partway through a registry load,
 * which surfaces as a page that renders half its agents. Eight at a time keeps
 * the walk fast without that.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

/** Resolve each engagement once, however many attestations reference it. */
async function scopesFor(attestations: readonly ChainAttestation[]): Promise<Map<string, string>> {
  const ids = [...new Set(attestations.map((entry) => entry.engagementId))]
  const engagements = await mapLimit(ids, 8, (id) => getEngagement(id))
  return new Map(engagements.map((engagement) => [engagement.id, engagement.scope]))
}

function grade(
  attestation: ChainAttestation,
  scope: string,
  policy: Policy,
): GradedAttestation {
  return {
    ...attestation,
    breakdown: explainWeight({
      substantiated: attestation.substantiated,
      confidence: attestation.confidence,
      repeatIndex: attestation.repeatIndex,
      ageSeconds: attestation.ageSeconds,
      policy,
    }),
    outcome: bondOutcome(
      { verdict: attestation.verdict, substantiated: attestation.substantiated },
      policy,
    ),
    scope,
    scopeDigestHex: scopeDigest(scope),
    salt: attestationSalt({
      scope,
      attester: attestation.attester,
      subject: attestation.subject,
      claim: attestation.claim,
    }),
  }
}

function concentrationOf(attestations: readonly GradedAttestation[], totalWeight: number): number {
  if (totalWeight <= 0) return 0
  const byAttester = new Map<string, number>()
  for (const entry of attestations) {
    byAttester.set(entry.attester, (byAttester.get(entry.attester) ?? 0) + entry.weight)
  }
  const heaviest = Math.max(0, ...byAttester.values())
  return Math.floor((heaviest * 10_000) / totalWeight)
}

/**
 * One agent's standing.
 *
 * The score is the contract's, not a local recomputation. `reportFor` is run
 * alongside it only as a cross-check: if the pinned port and the chain disagree
 * about an agent the site is quoting, that is worth knowing at the point it
 * happens rather than after someone acts on the number.
 */
export async function loadAgent(subject: string, override?: Policy): Promise<AgentReport> {
  // The deployed parameters, not the shipped constant. The contract computed the
  // weights being displayed under whatever it was constructed with, so a
  // breakdown derived from a different policy would explain a number that is not
  // the one beside it.
  const policy = override ?? (await getPolicy())
  const ids = await getSubjectAttestations(subject)
  const raw = await mapLimit(ids, 8, (id) => getAttestation(id))
  const scopes = await scopesFor(raw)
  const attestations = raw.map((entry) =>
    grade(entry, scopes.get(entry.engagementId) ?? '', policy),
  )

  const report = await getReport(subject)
  assertAgrees(subject, report, attestations, policy)

  return {
    address: subject.toLowerCase(),
    report,
    attestations,
    concentrationBp: concentrationOf(attestations, report.totalWeight),
    policy,
  }
}

/**
 * Warn when the chain's score and the local port disagree.
 *
 * Not thrown: the chain is the source of truth and the site should keep showing
 * its number even if the port drifts. But a silent divergence is the exact
 * failure the parity vectors exist to prevent, so it is made loud in the console
 * rather than absorbed.
 */
function assertAgrees(
  subject: string,
  chain: Report,
  attestations: readonly GradedAttestation[],
  policy: Policy,
): void {
  const local = reportFor(
    attestations.map((entry) => ({
      weight: entry.weight,
      gradeBp: entry.gradeBp,
      attester: entry.attester,
    })),
    policy,
  )

  if (local.scoreBp !== chain.scoreBp) {
    console.warn(
      `[credent] score mismatch for ${subject}: chain reported ${chain.scoreBp}bp, ` +
        `the local port derived ${local.scoreBp}bp from the same attestations. ` +
        `The chain's value is being shown. Re-run \`npm run parity\`.`,
    )
  }
}

/**
 * Every agent that has ever been attested about, best score first.
 *
 * Agents with no attestations are unreachable here by construction: an address
 * enters the registry by being the subject of one. That matches the contract,
 * where an unattested subject has no storage and `get_report` answers with the
 * neutral prior rather than a record.
 */
export async function loadRegistry(override?: Policy): Promise<AgentReport[]> {
  const policy = override ?? (await getPolicy())
  const count = await attestationCount()
  if (count === 0) return []

  const ids = Array.from({ length: count }, (_, index) => index)
  const raw = await mapLimit(ids, 8, (id) => getAttestation(id))
  const scopes = await scopesFor(raw)

  const bySubject = new Map<string, ChainAttestation[]>()
  for (const entry of raw) {
    const existing = bySubject.get(entry.subject)
    if (existing) existing.push(entry)
    else bySubject.set(entry.subject, [entry])
  }

  const subjects = [...bySubject.keys()]
  const reports = await mapLimit(subjects, 8, (subject) => getReport(subject))

  return subjects
    .map((subject, index) => {
      const attestations = (bySubject.get(subject) ?? []).map((entry) =>
        grade(entry, scopes.get(entry.engagementId) ?? '', policy),
      )
      const report = reports[index]
      assertAgrees(subject, report, attestations, policy)

      return {
        address: subject,
        report,
        attestations,
        concentrationBp: concentrationOf(attestations, report.totalWeight),
        policy,
      }
    })
    .sort((a, b) => b.report.scoreBp - a.report.scoreBp)
}
