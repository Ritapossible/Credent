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
 * attestation once, group by subject.
 *
 * That walk used to cost one request per attestation, plus one per engagement to
 * resolve its scope, plus one per subject for its score: `2 + N + E + S`. A
 * public RPC allowing thirty requests a minute could not answer it past about a
 * dozen attestations, which is roughly where a registry first becomes worth
 * looking at. It is now one request per page of attestations - each carrying its
 * engagement's scope - plus one per page of reports, so a full page of fifty
 * costs three calls rather than a hundred and fifty. Past a few thousand this
 * still wants a real indexer; that boundary is documented rather than hidden.
 */

import { bondOutcome, type BondOutcome } from '../core/bonding'
import { attestationSalt, scopeDigest } from '../core/digest'
import { type Policy } from '../core/policy'
import { explainWeight, type Report, type WeightBreakdown } from '../core/scoring'
import { reportFor } from '../core/simulate'
import {
  attestationCount,
  getAllAttestations,
  getAllSubjectPage,
  getPolicy,
  getReport,
  getReports,
  type ChainAttestationSummary,
} from './oracle'

export interface GradedAttestation extends ChainAttestationSummary {
  /** How the weight decomposes, recomputed locally from the pinned port. */
  breakdown: WeightBreakdown
  outcome: BondOutcome
  /**
   * The committed scope digest, recomputed here from the scope text.
   *
   * Kept beside the chain's own `scopeDigest` rather than replacing it: the two
   * agreeing is the evidence that the text on screen is the text that was
   * committed, and `digestMatches` says whether they do.
   */
  scopeDigestHex: string
  digestMatches: boolean
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

function grade(attestation: ChainAttestationSummary, policy: Policy): GradedAttestation {
  const recomputed = scopeDigest(attestation.scope)
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
    scopeDigestHex: recomputed,
    digestMatches: recomputed === attestation.scopeDigest,
    salt: attestationSalt({
      scope: attestation.scope,
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
  // Reduced rather than spread into `Math.max`. Spreading passes one argument
  // per attester, which has a ceiling in the tens of thousands and would throw
  // exactly for the agent with the most history.
  let heaviest = 0
  for (const weight of byAttester.values()) {
    if (weight > heaviest) heaviest = weight
  }
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
  // One request per page of this agent's history, scopes included, instead of
  // one per attestation plus one per engagement.
  const raw = await getAllSubjectPage(subject)
  const attestations = raw.map((entry) => grade(entry, policy))

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

  // Two calls plus one per page of attestations plus one per page of subjects,
  // rather than one per attestation, one per engagement and one per subject.
  // The old shape cost `2 + N + E + S` requests, which exhausts a public RPC's
  // thirty-a-minute budget at roughly a dozen attestations - the point at which
  // a registry first becomes worth reading. `get_attestations` carries each
  // engagement's scope with the record, so the per-engagement reads are gone
  // entirely rather than merely batched.
  const raw = await getAllAttestations(count)

  const bySubject = new Map<string, ChainAttestationSummary[]>()
  for (const entry of raw) {
    const existing = bySubject.get(entry.subject)
    if (existing) existing.push(entry)
    else bySubject.set(entry.subject, [entry])
  }

  const subjects = [...bySubject.keys()]
  const reports = await getReports(subjects)

  return subjects
    .flatMap((subject) => {
      const report = reports.get(subject)
      // A subject that appears in an attestation always has a report; a missing
      // one means the two views disagree about what exists, which is worth
      // surfacing rather than rendering as a zeroed row.
      if (report === undefined) {
        console.warn(`[credent] no report returned for ${subject}; omitting from the registry`)
        return []
      }

      const attestations = (bySubject.get(subject) ?? []).map((entry) =>
        grade(entry, policy),
      )
      assertAgrees(subject, report, attestations, policy)

      return [
        {
          address: subject,
          report,
          attestations,
          concentrationBp: concentrationOf(attestations, report.totalWeight),
          policy,
        },
      ]
    })
    .sort((a, b) => b.report.scoreBp - a.report.scoreBp)
}
