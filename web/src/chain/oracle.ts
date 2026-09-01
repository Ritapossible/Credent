/**
 * Typed reads against the deployed `ReputationOracle`.
 *
 * Every function here is a `@gl.public.view` on the contract, so none of them
 * cost gas, none need a wallet, and none can change state. The contract returns
 * Python dicts; the calldata decoder hands them back as plain objects with the
 * contract's own `snake_case` keys and integers that may arrive as `number` or
 * `bigint` depending on magnitude. This module is the single place that shape is
 * dealt with - past it, the app sees the same camelCase types `core/` already
 * uses.
 *
 * The decoding is defensive rather than trusting. A view that silently returned
 * `undefined` for a renamed field would surface as a score of `NaN` three
 * components away from the cause, so every field is pulled through a checked
 * accessor that names what was missing.
 */

import { CalldataAddress } from 'genlayer-js/types'

import type { Verdict } from '../core/bonding'
import type { Policy } from '../core/policy'
import type { Report } from '../core/scoring'
import { VERDICTS } from '../core/bonding'
import { isRateLimit } from '../core/errors'
import { readClient } from './client'
import { CONTRACT_ADDRESS, IS_CONFIGURED } from './config'

/** The bond lifecycle states the contract writes (`_BOND_*` in the shell). */
export type BondState = 'none' | 'locked' | 'released' | 'slashed'

const BOND_STATES: readonly BondState[] = ['none', 'locked', 'released', 'slashed']

export interface ChainAttestation {
  id: number
  engagementId: string
  attester: string
  subject: string
  claim: string
  evidence: string
  createdAt: number
  ageSeconds: number
  verdict: Verdict
  /**
   * The graded outcome in basis points. Stored on-chain as `fulfilled`; named
   * `gradeBp` here because that is what it is to every consumer of the score,
   * and because `core/` already spells it that way.
   */
  gradeBp: number
  substantiated: number
  confidence: number
  repeatIndex: number
  bond: bigint
  bondState: BondState
  /** Weight as of the block the read was answered at, computed by the contract. */
  weight: number
}

/**
 * The engagement lifecycle, as the contract spells it.
 *
 * `proposed` is the consent gap: the client has named a provider who has not
 * agreed to be graded yet, and nothing about the engagement can reach a score
 * until they do. A boolean `closed` cannot express it, which is why the contract
 * grew a `state` beside it.
 */
export type EngagementState = 'proposed' | 'open' | 'closed'

const ENGAGEMENT_STATES: readonly EngagementState[] = ['proposed', 'open', 'closed']

/**
 * The work-collateral lifecycle (`_COL_*` in the shell).
 *
 * `none` covers both an engagement that declared no stake and one nobody has
 * accepted yet. `held` is capital in flight; `releasable` and `forfeit` are what
 * the client's attestation settled it to; `returned` and `claimed` are where it
 * ended up.
 */
export type CollateralState = 'none' | 'held' | 'releasable' | 'forfeit' | 'returned' | 'claimed'

const COLLATERAL_STATES: readonly CollateralState[] = [
  'none',
  'held',
  'releasable',
  'forfeit',
  'returned',
  'claimed',
]

export interface ChainEngagement {
  id: string
  client: string
  provider: string
  scope: string
  scopeDigest: string
  state: EngagementState
  closed: boolean
  /** Declared value of the work, in wei. What the collateral is priced against. */
  stake: bigint
  /** When the dispute window on the collateral started. Zero until closed. */
  closedAt: number
  /** What the provider actually posted to accept. */
  collateral: bigint
  collateralState: CollateralState
  /** The rate that collateral was priced at, and the score that bought it. */
  collateralRateBp: number
  scoreBp: number
}

/** What taking on work of a given stake would cost one agent right now. */
export interface CollateralQuote {
  provider: string
  stake: bigint
  scoreBp: number
  rateBp: number
  required: bigint
  maxStake: bigint
}

// --- decoding -------------------------------------------------------------

type Dict = Record<string, unknown>

function asDict(value: unknown, what: string): Dict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what}: expected an object, received ${JSON.stringify(value)}`)
  }
  return value as Dict
}

/**
 * An integer field, however the decoder chose to represent it.
 *
 * `u256` values below 2^53 usually arrive as `number` and larger ones as
 * `bigint`, but which side of that line a field lands on depends on the value
 * rather than the type, so both are accepted everywhere.
 */
function int(source: Dict, key: string, what: string): number {
  const raw = source[key]
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw)
  throw new Error(`${what}.${key}: expected an integer, received ${JSON.stringify(raw)}`)
}

/**
 * A field that must stay exact past 2^53.
 *
 * Everything denominated in wei: `bond` and `minBond`, and now an engagement's
 * `stake` and the `collateral` derived from it, which are the largest amounts
 * the contract holds.
 */
function big(source: Dict, key: string, what: string): bigint {
  const raw = source[key]
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw)
  throw new Error(`${what}.${key}: expected an integer, received ${JSON.stringify(raw)}`)
}

function str(source: Dict, key: string, what: string): string {
  const raw = source[key]
  if (typeof raw === 'string') return raw
  throw new Error(`${what}.${key}: expected a string, received ${JSON.stringify(raw)}`)
}

function bool(source: Dict, key: string, what: string): boolean {
  const raw = source[key]
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  throw new Error(`${what}.${key}: expected a boolean, received ${JSON.stringify(raw)}`)
}

function address(source: Dict, key: string, what: string): string {
  return str(source, key, what).toLowerCase()
}

// --- encoding -------------------------------------------------------------

/**
 * An argument the contract declares as `Address`.
 *
 * Calldata is typed, and an address is its own type rather than a string that
 * happens to look like one. Passing the hex text encodes a `str`, which the
 * contract rejects while unpacking its arguments - the node answers the whole
 * call with `execution failed` and no indication of which argument was wrong.
 *
 * The views this client calls with an `Address` are `get_report`,
 * `get_subject_page`, `get_reports`, `bond_for_next` and `collateral_quote`;
 * one write takes one too (`open_engagement`). The rest take strings and
 * integers, which encode as themselves.
 *
 * Exported for `wallet.ts` rather than reimplemented there. The writes hit the
 * same encoding, and a second copy of this is how the bug comes back on the
 * side nobody re-tested.
 *
 * The parse is strict because the alternative is that failure again, one layer
 * further away: a malformed address here would encode 20 bytes of `NaN`, and the
 * call would fail identically to a missing contract.
 */
export function addressArg(hex: string, what: string): CalldataAddress {
  // The prefix is matched case-insensitively along with the digits. `0X…` is
  // unusual but it is a shape addresses genuinely arrive in when pasted, and
  // rejecting it produced a "not a 20-byte hex address" error about a string
  // that plainly was one.
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`${what}: expected a 20-byte hex address, received ${JSON.stringify(hex)}`)
  }
  const bytes = new Uint8Array(20)
  for (let index = 0; index < 20; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16)
  }
  return new CalldataAddress(bytes)
}

/**
 * How long to wait before a retry, or null if this failure will not pass.
 *
 * Only rate limiting is retried. A rejected call, a bad address or a missing
 * contract will fail identically however long you wait, and retrying them turns
 * one clear error into three slow ones. The public studio RPC allows thirty
 * requests a minute and answers `-32029` with a `retry_after_seconds` when it
 * has had enough; that hint is honoured when present.
 */
function retryDelay(cause: unknown, attempt: number): number | null {
  if (!isRateLimit(cause)) return null
  if (attempt >= 3) return null

  const hinted = (cause as { cause?: { data?: { retry_after_seconds?: unknown } } })?.cause?.data
    ?.retry_after_seconds
  if (typeof hinted === 'number' && hinted > 0) return Math.min(hinted, 60) * 1000

  // Otherwise back off: 1s, 2s, 4s.
  return 2 ** attempt * 1000
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(functionName: string, args: unknown[] = []): Promise<unknown> {
  if (!IS_CONFIGURED) {
    throw new Error(
      'No contract address configured. Set VITE_CONTRACT_ADDRESS to the deployed ' +
        'ReputationOracle before building.',
    )
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readClient().readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName,
        // The decoder's `CalldataEncodable` covers the string, integer and
        // address arguments every view here takes; the cast keeps that detail
        // out of each call site.
        args: args as never[],
      })
    } catch (cause) {
      const delay = retryDelay(cause, attempt)
      if (delay === null) throw cause
      await sleep(delay)
    }
  }
}

/**
 * A `u256` returned on its own rather than inside a dict.
 *
 * The string branch is not decoration. The decoder represents integers past
 * 2^53 as strings, and the two scalar views here each hand-rolled a check that
 * accepted only `bigint` and `number` - so `bond_for_next` threw
 * "expected an integer, received "1000000000000000000"" the moment the
 * deployment carried a bond of one whole token. The field decoders inside dicts
 * had always accepted strings; only the top-level ones had not, which is why it
 * survived until a bond got large.
 */
function scalar(raw: unknown, what: string): bigint {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw)
  throw new Error(`${what}: expected an integer, received ${JSON.stringify(raw)}`)
}

// --- views ----------------------------------------------------------------

/** How many attestations exist in total. Also the id of the next one. */
export async function attestationCount(): Promise<number> {
  return Number(scalar(await call('attestation_count'), 'attestation_count'))
}

export async function getReport(subject: string): Promise<Report> {
  const source = asDict(
    await call('get_report', [addressArg(subject, 'get_report.subject')]),
    'get_report',
  )
  return {
    scoreBp: int(source, 'score_bp', 'get_report'),
    totalWeight: int(source, 'total_weight', 'get_report'),
    nAttestations: int(source, 'n_attestations', 'get_report'),
    nDistinctAttesters: int(source, 'n_distinct_attesters', 'get_report'),
    nCounted: int(source, 'n_counted', 'get_report'),
  }
}

/**
 * How many records any paged view will return at most.
 *
 * Mirrors `_PAGE_MAX` in the contract, which clamps rather than rejects, so a
 * client that asks for more silently gets this many - meaning a caller who
 * assumed otherwise would read a truncated list and never know. Every pager
 * below walks in these steps and stops on a short page.
 */
export const PAGE_SIZE = 50

/**
 * A page of attestations, with their engagement's scope, in one call.
 *
 * The batch view exists so the registry does not cost one request per
 * attestation plus one per engagement plus one per subject. `evidence` is not
 * carried - see `get_attestations` in the contract - so this returns the list
 * shape rather than the full record.
 */
export interface ChainAttestationSummary extends Omit<ChainAttestation, 'evidence'> {
  scope: string
  scopeDigest: string
}

function decodeSummary(value: unknown): ChainAttestationSummary {
  const source = asDict(value, 'get_attestations')

  const verdict = str(source, 'verdict', 'get_attestations')
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`get_attestations.verdict: unknown verdict "${verdict}"`)
  }
  const bondState = str(source, 'bond_state', 'get_attestations')
  if (!(BOND_STATES as readonly string[]).includes(bondState)) {
    throw new Error(`get_attestations.bond_state: unknown state "${bondState}"`)
  }

  return {
    id: int(source, 'id', 'get_attestations'),
    engagementId: str(source, 'engagement_id', 'get_attestations'),
    attester: address(source, 'attester', 'get_attestations'),
    subject: address(source, 'subject', 'get_attestations'),
    claim: str(source, 'claim', 'get_attestations'),
    scope: str(source, 'scope', 'get_attestations'),
    scopeDigest: str(source, 'scope_digest', 'get_attestations'),
    createdAt: int(source, 'created_at', 'get_attestations'),
    ageSeconds: int(source, 'age_seconds', 'get_attestations'),
    verdict: verdict as Verdict,
    gradeBp: int(source, 'fulfilled', 'get_attestations'),
    substantiated: int(source, 'substantiated', 'get_attestations'),
    confidence: int(source, 'confidence', 'get_attestations'),
    repeatIndex: int(source, 'repeat_index', 'get_attestations'),
    bond: big(source, 'bond', 'get_attestations'),
    bondState: bondState as BondState,
    weight: int(source, 'weight', 'get_attestations'),
  }
}

export async function getAttestations(
  offset = 0,
  limit = PAGE_SIZE,
): Promise<ChainAttestationSummary[]> {
  const raw = await call('get_attestations', [offset, limit])
  if (!Array.isArray(raw)) {
    throw new Error(`get_attestations: expected a list, received ${JSON.stringify(raw)}`)
  }
  return raw.map(decodeSummary)
}

/** Every attestation, walking the pages. One request per `PAGE_SIZE` records. */
export async function getAllAttestations(total: number): Promise<ChainAttestationSummary[]> {
  const out: ChainAttestationSummary[] = []
  while (out.length < total) {
    const page = await getAttestations(out.length, PAGE_SIZE)
    if (page.length === 0) break
    out.push(...page)
  }
  return out
}

/** One page of attestations about a single subject, with scopes attached. */
export async function getSubjectPage(
  subject: string,
  offset = 0,
  limit = PAGE_SIZE,
): Promise<ChainAttestationSummary[]> {
  const raw = await call('get_subject_page', [
    addressArg(subject, 'get_subject_page.subject'),
    offset,
    limit,
  ])
  if (!Array.isArray(raw)) {
    throw new Error(`get_subject_page: expected a list, received ${JSON.stringify(raw)}`)
  }
  return raw.map(decodeSummary)
}

/** Every attestation about one subject, walking the pages. */
export async function getAllSubjectPage(subject: string): Promise<ChainAttestationSummary[]> {
  const out: ChainAttestationSummary[] = []
  for (;;) {
    const page = await getSubjectPage(subject, out.length, PAGE_SIZE)
    out.push(...page)
    if (page.length < PAGE_SIZE) return out
  }
}

/** Standing for several agents in one call, keyed back to the subject it is for. */
export async function getReports(subjects: readonly string[]): Promise<Map<string, Report>> {
  if (subjects.length === 0) return new Map()

  const out = new Map<string, Report>()
  for (let start = 0; start < subjects.length; start += PAGE_SIZE) {
    const page = subjects.slice(start, start + PAGE_SIZE)
    const raw = await call('get_reports', [
      page.map((subject, index) => addressArg(subject, `get_reports.subjects[${index}]`)),
    ])
    if (!Array.isArray(raw)) {
      throw new Error(`get_reports: expected a list, received ${JSON.stringify(raw)}`)
    }
    for (const entry of raw) {
      const source = asDict(entry, 'get_reports')
      out.set(address(source, 'subject', 'get_reports'), {
        scoreBp: int(source, 'score_bp', 'get_reports'),
        totalWeight: int(source, 'total_weight', 'get_reports'),
        nAttestations: int(source, 'n_attestations', 'get_reports'),
        nDistinctAttesters: int(source, 'n_distinct_attesters', 'get_reports'),
        nCounted: int(source, 'n_counted', 'get_reports'),
      })
    }
  }
  return out
}

export async function getEngagement(id: string): Promise<ChainEngagement> {
  const source = asDict(await call('get_engagement', [id]), 'get_engagement')

  const state = str(source, 'state', 'get_engagement')
  if (!(ENGAGEMENT_STATES as readonly string[]).includes(state)) {
    throw new Error(`get_engagement.state: unknown state "${state}"`)
  }

  const collateralState = str(source, 'collateral_state', 'get_engagement')
  if (!(COLLATERAL_STATES as readonly string[]).includes(collateralState)) {
    throw new Error(`get_engagement.collateral_state: unknown state "${collateralState}"`)
  }

  return {
    id: str(source, 'id', 'get_engagement'),
    client: address(source, 'client', 'get_engagement'),
    provider: address(source, 'provider', 'get_engagement'),
    scope: str(source, 'scope', 'get_engagement'),
    scopeDigest: str(source, 'scope_digest', 'get_engagement'),
    state: state as EngagementState,
    closed: bool(source, 'closed', 'get_engagement'),
    // Stake and collateral stay `bigint`: both are wei-denominated and a real
    // engagement's stake is past 2^53 before it is worth talking about.
    stake: big(source, 'stake', 'get_engagement'),
    closedAt: int(source, 'closed_at', 'get_engagement'),
    collateral: big(source, 'collateral', 'get_engagement'),
    collateralState: collateralState as CollateralState,
    collateralRateBp: int(source, 'collateral_rate_bp', 'get_engagement'),
    scoreBp: int(source, 'score_bp', 'get_engagement'),
  }
}

/**
 * The parameters the contract actually deployed with.
 *
 * The site ships a `CREDENT_POLICY` constant, but a build pointed at a contract
 * deployed with different parameters would otherwise quote weights nobody on
 * chain agrees with. Reading them means the explainers describe the deployment
 * in front of the visitor rather than the one in the source tree.
 */
export async function getPolicy(): Promise<Policy> {
  const source = asDict(await call('get_policy'), 'get_policy')
  return {
    halfLifeSeconds: int(source, 'half_life_seconds', 'get_policy'),
    priorWeight: int(source, 'prior_weight', 'get_policy'),
    minSubstantiated: int(source, 'min_substantiated', 'get_policy'),
    minConfidence: int(source, 'min_confidence', 'get_policy'),
    confidenceTol: int(source, 'confidence_tol', 'get_policy'),
    repeatShiftCap: int(source, 'repeat_shift_cap', 'get_policy'),
    minBond: big(source, 'min_bond', 'get_policy'),
    slashFloor: int(source, 'slash_floor', 'get_policy'),
    releaseFloor: int(source, 'release_floor', 'get_policy'),
    bondLockSeconds: int(source, 'bond_lock_seconds', 'get_policy'),
    withdrawalSettleSeconds: int(source, 'withdrawal_settle_seconds', 'get_policy'),
    collateralCeilingBp: int(source, 'collateral_ceiling_bp', 'get_policy'),
    collateralFloorBp: int(source, 'collateral_floor_bp', 'get_policy'),
    collateralForfeitBp: int(source, 'collateral_forfeit_bp', 'get_policy'),
  }
}

/**
 * What it would cost this agent to take on work worth `stake`, right now.
 *
 * The read-side twin of the gate in `accept_engagement`, so a provider sees the
 * price before they sign rather than discovering it from a rejection. The
 * contract computes it from the same stored grades `get_report` walks - asking
 * the chain rather than deriving it here means the figure is the one the write
 * path will actually check against, including any policy this build does not
 * know about.
 *
 * A quote goes stale the moment another attestation about this provider lands,
 * so a caller that is about to send value should re-read it at submit time.
 */
export async function collateralQuote(provider: string, stake: bigint): Promise<CollateralQuote> {
  const source = asDict(
    await call('collateral_quote', [
      addressArg(provider, 'collateral_quote.provider'),
      // Passed as a `bigint`, which the calldata encoder writes as an integer
      // of arbitrary width. A wei-scale stake is past 2^53, so handing it over
      // as a `number` would encode a rounded stake and quote collateral for
      // work worth slightly less than the one being opened.
      stake,
    ]),
    'collateral_quote',
  )
  return {
    provider: address(source, 'provider', 'collateral_quote'),
    stake: big(source, 'stake', 'collateral_quote'),
    scoreBp: int(source, 'score_bp', 'collateral_quote'),
    rateBp: int(source, 'rate_bp', 'collateral_quote'),
    required: big(source, 'required', 'collateral_quote'),
    maxStake: big(source, 'max_stake', 'collateral_quote'),
  }
}

/** What the contract owes an address and has not yet paid out. */
export async function owedTo(recipient: string): Promise<bigint> {
  return scalar(await call('owed_to', [recipient]), 'owed_to')
}

/**
 * Whether `withdraw` will deliver to this address.
 *
 * True only once the address has completed the contract's payout handshake,
 * which needs code to run and so cannot be faked by a wallet. `withdraw` is
 * refused for anything else, which is what stops value being emitted at an
 * address that cannot receive it.
 */
export async function isProven(recipient: string): Promise<boolean> {
  return (await call('is_proven', [recipient])) === true
}

export interface Liabilities {
  totalOwed: bigint
  inFlight: bigint
  bonds: bigint
  collateral: bigint
  obligations: bigint
  held: bigint
}

/**
 * A reader's summary of what the contract owes against what it holds.
 *
 * Reported piece by piece rather than netted, because the whole history of bugs
 * on this path is one figure being mistaken for another. `totalOwed` is
 * entitlements alone; `bonds` and `collateral` are money held for somebody else
 * that is not an entitlement yet; `obligations` is the sum of all of it with
 * anything in flight. `held − obligations` is genuine surplus, and it is the
 * only money a restore is allowed to come out of.
 */
export async function liabilities(): Promise<Liabilities> {
  const source = asDict(await call('liabilities', []), 'liabilities')
  return {
    totalOwed: big(source, 'total_owed', 'liabilities'),
    inFlight: big(source, 'total_in_flight', 'liabilities'),
    bonds: big(source, 'total_bond', 'liabilities'),
    collateral: big(source, 'total_collateral', 'liabilities'),
    obligations: big(source, 'obligations', 'liabilities'),
    held: big(source, 'held', 'liabilities'),
  }
}

/** What the next attestation from this attester about this subject would cost. */
export async function bondForNext(attester: string, subject: string): Promise<bigint> {
  const raw = await call('bond_for_next', [
    addressArg(attester, 'bond_for_next.attester'),
    addressArg(subject, 'bond_for_next.subject'),
  ])
  return scalar(raw, 'bond_for_next')
}
