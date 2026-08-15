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

import type { Verdict } from '../core/bonding'
import type { Policy } from '../core/policy'
import type { Report } from '../core/scoring'
import { VERDICTS } from '../core/bonding'
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

export interface ChainEngagement {
  id: string
  client: string
  provider: string
  scope: string
  scopeDigest: string
  closed: boolean
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

/** A field that must stay exact past 2^53 - only `bond` and `minBond` qualify. */
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

function call(functionName: string, args: unknown[] = []): Promise<unknown> {
  if (!IS_CONFIGURED) {
    throw new Error(
      'No contract address configured. Set VITE_CONTRACT_ADDRESS to the deployed ' +
        'ReputationOracle before building.',
    )
  }
  return readClient().readContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName,
    // The decoder's `CalldataEncodable` covers the string and integer arguments
    // every view here takes; the cast keeps that detail out of each call site.
    args: args as never[],
  })
}

// --- views ----------------------------------------------------------------

/** How many attestations exist in total. Also the id of the next one. */
export async function attestationCount(): Promise<number> {
  const raw = await call('attestation_count')
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'number') return raw
  throw new Error(`attestation_count: expected an integer, received ${JSON.stringify(raw)}`)
}

export async function getReport(subject: string): Promise<Report> {
  const source = asDict(await call('get_report', [subject]), 'get_report')
  return {
    scoreBp: int(source, 'score_bp', 'get_report'),
    totalWeight: int(source, 'total_weight', 'get_report'),
    nAttestations: int(source, 'n_attestations', 'get_report'),
    nDistinctAttesters: int(source, 'n_distinct_attesters', 'get_report'),
    nCounted: int(source, 'n_counted', 'get_report'),
  }
}

export async function getAttestation(id: number): Promise<ChainAttestation> {
  const source = asDict(await call('get_attestation', [id]), 'get_attestation')

  const verdict = str(source, 'verdict', 'get_attestation')
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`get_attestation.verdict: unknown verdict "${verdict}"`)
  }

  const bondState = str(source, 'bond_state', 'get_attestation')
  if (!(BOND_STATES as readonly string[]).includes(bondState)) {
    throw new Error(`get_attestation.bond_state: unknown state "${bondState}"`)
  }

  return {
    id: int(source, 'id', 'get_attestation'),
    engagementId: str(source, 'engagement_id', 'get_attestation'),
    attester: address(source, 'attester', 'get_attestation'),
    subject: address(source, 'subject', 'get_attestation'),
    claim: str(source, 'claim', 'get_attestation'),
    evidence: str(source, 'evidence', 'get_attestation'),
    createdAt: int(source, 'created_at', 'get_attestation'),
    ageSeconds: int(source, 'age_seconds', 'get_attestation'),
    verdict: verdict as Verdict,
    gradeBp: int(source, 'fulfilled', 'get_attestation'),
    substantiated: int(source, 'substantiated', 'get_attestation'),
    confidence: int(source, 'confidence', 'get_attestation'),
    repeatIndex: int(source, 'repeat_index', 'get_attestation'),
    bond: big(source, 'bond', 'get_attestation'),
    bondState: bondState as BondState,
    weight: int(source, 'weight', 'get_attestation'),
  }
}

export async function getSubjectAttestations(subject: string): Promise<number[]> {
  const raw = await call('get_subject_attestations', [subject])
  if (!Array.isArray(raw)) {
    throw new Error(`get_subject_attestations: expected a list, received ${JSON.stringify(raw)}`)
  }
  return raw.map((entry) => (typeof entry === 'bigint' ? Number(entry) : Number(entry)))
}

export async function getEngagement(id: string): Promise<ChainEngagement> {
  const source = asDict(await call('get_engagement', [id]), 'get_engagement')
  return {
    id: str(source, 'id', 'get_engagement'),
    client: address(source, 'client', 'get_engagement'),
    provider: address(source, 'provider', 'get_engagement'),
    scope: str(source, 'scope', 'get_engagement'),
    scopeDigest: str(source, 'scope_digest', 'get_engagement'),
    closed: bool(source, 'closed', 'get_engagement'),
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
  }
}

/** What the next attestation from this attester about this subject would cost. */
export async function bondForNext(attester: string, subject: string): Promise<bigint> {
  const raw = await call('bond_for_next', [attester, subject])
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number') return BigInt(raw)
  throw new Error(`bond_for_next: expected an integer, received ${JSON.stringify(raw)}`)
}
