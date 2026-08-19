/**
 * Check the TypeScript port against the Python engine.
 *
 * `src/core/` reimplements `reputation_core.py` so the UI can show a score
 * without a round trip. Two implementations of one piece of consensus arithmetic
 * drift, and the drift is silent: both sides keep returning plausible integers,
 * just not the same ones. A user would see a number the chain does not agree
 * with and have no way to tell.
 *
 * So neither side moves alone. `parity_vectors.py` evaluates the engine over a
 * fixed grid and writes `parity_vectors.json`; this runs the port over the same
 * grid and exits non-zero on the first family that disagrees, listing the inputs.
 *
 * Run it with `npm run parity` after touching either implementation.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { aggregate, attestationWeight, decayBp, repeatShift } from '../src/core/scoring'
import { bondOutcome, bondRequired } from '../src/core/bonding'
import {
  collateralOutcome,
  collateralRateBp,
  collateralRequired,
  maxStake,
} from '../src/core/collateral'
import { attestationSalt, normalizeAddress, scopeDigest } from '../src/core/digest'
import type { Policy } from '../src/core/policy'

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS = join(HERE, '..', '..', 'parity_vectors.json')

/** The generated file, as it is shaped on disk. */
interface VectorFile {
  policies: Record<string, Record<string, number | string>>
  decayBp: { weight: number; ageSeconds: number; halfLifeSeconds: number; expected: number }[]
  repeatShift: { repeatIndex: number; policy: string; expected: number }[]
  attestationWeight: {
    substantiated: number
    confidence: number
    repeatIndex: number
    ageSeconds: number
    policy: string
    expected: number
  }[]
  aggregate: {
    entries: [number, number][]
    policy: string
    expected: { scoreBp: number; totalWeight: number }
  }[]
  bondRequired: { repeatIndex: number; policy: string; expected: string }[]
  bondOutcome: { grade: Record<string, unknown>; policy: string; expected: string }[]
  collateralRate: { scoreBp: number; policy: string; expected: number }[]
  collateralRequired: { scoreBp: number; stake: string; policy: string; expected: string }[]
  maxStake: { policy: string; expected: string }[]
  collateralOutcome: { grade: Record<string, unknown>; policy: string; expected: string }[]
  normalizeAddress: { text: string; expected: string }[]
  scopeDigest: { scope: string; expected: string }[]
  attestationSalt: {
    scope: string
    attester: string
    subject: string
    claim: string
    expected: string
  }[]
}

/**
 * Rebuild a `Policy` from the generated JSON.
 *
 * The policies are read from the file rather than imported from `core/policy`
 * on purpose. Importing them would compare the port against itself: a parameter
 * that drifted on one side would drift in both the input and the expectation and
 * cancel out. `minBond` arrives as a string because it is a `bigint` here and
 * routinely exceeds `Number.MAX_SAFE_INTEGER`.
 */
function toPolicy(raw: Record<string, number | string>): Policy {
  return {
    halfLifeSeconds: Number(raw.halfLifeSeconds),
    priorWeight: Number(raw.priorWeight),
    minSubstantiated: Number(raw.minSubstantiated),
    minConfidence: Number(raw.minConfidence),
    confidenceTol: Number(raw.confidenceTol),
    repeatShiftCap: Number(raw.repeatShiftCap),
    minBond: BigInt(raw.minBond as string),
    slashFloor: Number(raw.slashFloor),
    releaseFloor: Number(raw.releaseFloor),
    bondLockSeconds: Number(raw.bondLockSeconds),
    collateralCeilingBp: Number(raw.collateralCeilingBp),
    collateralFloorBp: Number(raw.collateralFloorBp),
    collateralForfeitBp: Number(raw.collateralForfeitBp),
  }
}

interface Mismatch {
  inputs: unknown
  expected: unknown
  actual: unknown
}

let checked = 0
const failures: { family: string; mismatches: Mismatch[] }[] = []

/**
 * Run one family of vectors.
 *
 * Every mismatch in a family is collected rather than the first: one wrong
 * operator produces hundreds, and their shape - all the aged ones, or only the
 * ones past the shift cap - is what points at the cause.
 */
function check<T extends { expected: unknown }>(
  family: string,
  vectors: T[],
  actual: (vector: T) => unknown,
): void {
  const mismatches: Mismatch[] = []
  for (const vector of vectors) {
    checked += 1
    const got = actual(vector)
    const { expected, ...inputs } = vector
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      mismatches.push({ inputs, expected, actual: got })
    }
  }
  if (mismatches.length > 0) failures.push({ family, mismatches })
}

const file: VectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'))
const policies = new Map(
  Object.entries(file.policies).map(([name, raw]) => [name, toPolicy(raw)]),
)

/** Fail loudly rather than silently skipping a family whose policy went missing. */
function policyNamed(name: string): Policy {
  const policy = policies.get(name)
  if (policy === undefined) throw new Error(`vector file has no policy named ${name}`)
  return policy
}

check('decayBp', file.decayBp, (v) => decayBp(v.weight, v.ageSeconds, v.halfLifeSeconds))

check('repeatShift', file.repeatShift, (v) => repeatShift(v.repeatIndex, policyNamed(v.policy)))

check('attestationWeight', file.attestationWeight, (v) =>
  attestationWeight({
    substantiated: v.substantiated,
    confidence: v.confidence,
    repeatIndex: v.repeatIndex,
    ageSeconds: v.ageSeconds,
    policy: policyNamed(v.policy),
  }),
)

check('aggregate', file.aggregate, (v) => aggregate(v.entries, policyNamed(v.policy)))

// Compared as decimal strings: the Python side is unbounded and the port is a
// `bigint`, and going through a JSON number would round both into agreement.
check('bondRequired', file.bondRequired, (v) =>
  bondRequired(v.repeatIndex, policyNamed(v.policy)).toString(),
)

check('bondOutcome', file.bondOutcome, (v) => bondOutcome(v.grade, policyNamed(v.policy)))

check('collateralRate', file.collateralRate, (v) =>
  collateralRateBp(v.scoreBp, policyNamed(v.policy)),
)

// Stakes and collateral cross as decimal strings for the same reason bonds do:
// both are wei-denominated and past `Number.MAX_SAFE_INTEGER` at any realistic
// engagement, and a JSON number would round the two sides into agreeing.
check('collateralRequired', file.collateralRequired, (v) =>
  collateralRequired(v.scoreBp, BigInt(v.stake), policyNamed(v.policy)).toString(),
)

check('maxStake', file.maxStake, (v) => maxStake(policyNamed(v.policy)).toString())

check('collateralOutcome', file.collateralOutcome, (v) =>
  collateralOutcome(v.grade, policyNamed(v.policy)),
)

check('normalizeAddress', file.normalizeAddress, (v) => normalizeAddress(v.text))

check('scopeDigest', file.scopeDigest, (v) => scopeDigest(v.scope))

check('attestationSalt', file.attestationSalt, (v) =>
  attestationSalt({
    scope: v.scope,
    attester: v.attester,
    subject: v.subject,
    claim: v.claim,
  }),
)

if (failures.length === 0) {
  console.log(`parity ok - ${checked} vectors across 13 families agree with the engine`)
  process.exit(0)
}

const total = failures.reduce((sum, f) => sum + f.mismatches.length, 0)
console.error(`parity FAILED - ${total} of ${checked} vectors disagree with the engine\n`)
for (const { family, mismatches } of failures) {
  console.error(`${family}: ${mismatches.length} mismatch(es)`)
  // Enough to see the pattern without burying it; the count above is the total.
  for (const mismatch of mismatches.slice(0, 5)) {
    console.error(`  inputs   ${JSON.stringify(mismatch.inputs)}`)
    console.error(`  expected ${JSON.stringify(mismatch.expected)}`)
    console.error(`  actual   ${JSON.stringify(mismatch.actual)}\n`)
  }
  if (mismatches.length > 5) console.error(`  ... and ${mismatches.length - 5} more\n`)
}
process.exit(1)
