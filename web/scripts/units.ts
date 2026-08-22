/**
 * Assertions over the helpers the site depends on but the parity vectors do not
 * reach.
 *
 * `npm run parity` pins the ported *arithmetic* against the Python engine, which
 * is the part that must never drift. It says nothing about the presentation and
 * decoding layers around it, and those have already shipped two defects worth
 * catching here: a bond formatted at the wrong number of decimals, and error
 * text that reached the page carrying a library version string.
 *
 * Written as a script rather than a test-runner suite for the same reason
 * `parity.ts` is: it runs under plain Node through the bundler the project
 * already uses, so it costs no new dependency and CI runs it the same way it
 * runs everything else.
 */

import { NATIVE_SYMBOL, formatBond, formatUnits, parseTokens } from '../src/core/format'
import { collateralRateBp, collateralRequired, maxStake } from '../src/core/collateral'
import { BP } from '../src/core/policy'
import { isRateLimit, readableError } from '../src/core/errors'
import { addressArg } from '../src/chain/oracle'
import { outcomeOf } from '../src/chain/wallet'
import { settlesToWallet } from '../src/chain/config'
import { localnet, studionet, testnetAsimov, testnetBradbury } from 'genlayer-js/chains'
import type { GenLayerTransaction } from 'genlayer-js/types'
import { CREDENT_POLICY, DEFAULT_POLICY } from '../src/core/policy'

let failures = 0
let checks = 0

function eq(actual: unknown, expected: unknown, what: string): void {
  checks += 1
  const a = typeof actual === 'bigint' ? `${actual}n` : JSON.stringify(actual)
  const b = typeof expected === 'bigint' ? `${expected}n` : JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`FAIL ${what}\n  expected ${b}\n  received ${a}`)
  }
}

function throws(fn: () => unknown, what: string): void {
  checks += 1
  try {
    fn()
    failures += 1
    console.error(`FAIL ${what}\n  expected a throw, nothing was thrown`)
  } catch {
    // expected
  }
}

// --- denomination ---------------------------------------------------------
//
// The bond is the chain's native token at 18 decimals. It was formatted as USDC
// at 6, which read every amount twelve orders of magnitude off - a bond the site
// called "25 USDC" was 0.000000000025 GEN on chain.

const GEN = 10n ** 18n

eq(formatBond(0n), `0 ${NATIVE_SYMBOL}`, 'formatBond: zero')
eq(formatBond(GEN), `1 ${NATIVE_SYMBOL}`, 'formatBond: one whole token')
eq(formatBond(25n * GEN), `25 ${NATIVE_SYMBOL}`, 'formatBond: twenty-five')
eq(formatBond(GEN / 2n), `0.5 ${NATIVE_SYMBOL}`, 'formatBond: a half')
eq(formatBond(1_500n * GEN), `1,500 ${NATIVE_SYMBOL}`, 'formatBond: thousands are grouped')
// Dust must not round up into a number someone could mistake for a real bond.
eq(formatBond(1n), `0 ${NATIVE_SYMBOL}`, 'formatBond: one wei displays as zero, not as 1')
eq(formatUnits(GEN), '1', 'formatUnits: exact at 18 decimals')

// The value that was wrong, asserted at its intended magnitude so it cannot
// silently return to a six-decimal figure.
eq(CREDENT_POLICY.minBond, GEN, 'CREDENT_POLICY.minBond is one whole token in wei')
eq(DEFAULT_POLICY.minBond, 0n, 'the contract default leaves the economic layer off')

// --- error presentation ---------------------------------------------------

eq(
  readableError(
    new Error(
      'Requested resource not found.\n\nDetails: Transaction 0xabc not found\nVersion: viem@2.55.13',
    ),
  ),
  'Transaction 0xabc not found',
  'readableError: a generic viem headline yields to its Details line',
)
eq(
  readableError(new Error('attest was rejected by the contract: [EXPECTED] already_attested')),
  'attest was rejected by the contract: [EXPECTED] already_attested',
  'readableError: our own sentences pass through untouched',
)
eq(
  readableError(new Error('Details: something specific\nVersion: viem@2.55.13')),
  'something specific',
  'readableError: a leading Details line loses its label',
)
eq(readableError(new Error('')), 'Something went wrong.', 'readableError: empty message')
eq(readableError('a bare string'), 'a bare string', 'readableError: non-Error input')
eq(
  readableError(new Error(`${'x'.repeat(400)}`)).length,
  300,
  'readableError: long messages are truncated',
)

eq(isRateLimit(new Error('Rate limit exceeded: 30 requests per minute')), true, 'isRateLimit: hit')
eq(isRateLimit(new Error('no such engagement')), false, 'isRateLimit: unrelated failure')

// --- address encoding -----------------------------------------------------
//
// Passing hex text where the contract declares `Address` encodes a `str`, which
// the node rejects with an unattributed "execution failed".

eq(
  Array.from(addressArg('0x2544ef55d918ab058b82707b24ed9cd58882dd31', 'test').bytes).length,
  20,
  'addressArg: encodes twenty bytes',
)
eq(
  Array.from(addressArg('0x2544ef55d918ab058b82707b24ed9cd58882dd31', 'test').bytes)[0],
  0x25,
  'addressArg: first byte is parsed, not stringified',
)
eq(
  Array.from(addressArg('0X2544EF55D918AB058B82707B24ED9CD58882DD31', 'test').bytes)[19],
  0x31,
  'addressArg: accepts upper case',
)
throws(() => addressArg('not-an-address', 'test'), 'addressArg: rejects non-hex')
throws(() => addressArg('0x2544ef', 'test'), 'addressArg: rejects a short address')
throws(() => addressArg('', 'test'), 'addressArg: rejects empty')

// --- large integers -------------------------------------------------------
//
// The decoder hands back integers past 2^53 as strings. `bond_for_next` accepted
// only bigint and number, so it threw the moment a deployment carried a bond of
// one whole token - a failure that could not appear while `min_bond` was zero.

eq(
  formatBond(BigInt('1000000000000000000')),
  `1 ${NATIVE_SYMBOL}`,
  'a bond arriving as a decimal string survives the round trip',
)
// 2^256 - 1: the last eighteen digits are the fraction, the leading sixty the
// whole part. Asserted in full because a float would have lost all of it.
eq(
  formatUnits(
    BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'),
  ),
  '115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935',
  'formatUnits: exact at the u256 ceiling, with no float rounding',
)

// --- stakes typed by a human ----------------------------------------------
//
// A stake is entered as "2.5", stored as wei, and priced against by the
// contract. The parse has to be exact in both directions and refuse anything it
// cannot represent - a stake that silently rounded would price collateral for
// work worth a different amount than the one being opened.

eq(parseTokens(''), 0n, 'parseTokens: an empty field is an engagement with no stake')
eq(parseTokens('1'), GEN, 'parseTokens: one whole token')
eq(parseTokens('2.5'), GEN * 5n / 2n, 'parseTokens: a fraction')
eq(parseTokens('0.000000000000000001'), 1n, 'parseTokens: one wei')
eq(parseTokens('1,500'), 1_500n * GEN, 'parseTokens: grouped digits, as formatUnits writes them')
eq(parseTokens(formatUnits(12_345n * GEN)), 12_345n * GEN, 'parseTokens: round trips formatUnits')
eq(parseTokens('0.0000000000000000001'), null, 'parseTokens: refuses more decimals than the token has')
eq(parseTokens('-1'), null, 'parseTokens: refuses a negative stake')
eq(parseTokens('abc'), null, 'parseTokens: refuses text')
eq(parseTokens('1.2.3'), null, 'parseTokens: refuses two points')

// --- work collateral ------------------------------------------------------
//
// `npm run parity` pins these against the Python engine across the whole grid.
// What is asserted here is the shape the *interface* depends on: that the
// deployed policy actually discounts, that the discount is bounded, and that the
// numbers the accept card quotes are the ones the contract will charge.

eq(
  collateralRateBp(0, CREDENT_POLICY),
  CREDENT_POLICY.collateralCeilingBp,
  'collateralRateBp: no record pays the ceiling',
)
eq(
  collateralRateBp(BP, CREDENT_POLICY),
  CREDENT_POLICY.collateralFloorBp,
  'collateralRateBp: a perfect record pays the floor',
)
eq(collateralRateBp(5000, CREDENT_POLICY), 8750, 'collateralRateBp: an unknown agent sits between')
eq(
  collateralRequired(5000, 100n * GEN, CREDENT_POLICY),
  875n * GEN / 10n,
  'collateralRequired: 87.5 GEN against a 100 GEN stake at the neutral score',
)
eq(
  collateralRequired(8500, 100n * GEN, CREDENT_POLICY) < collateralRequired(5000, 100n * GEN, CREDENT_POLICY),
  true,
  'collateralRequired: a better score frees working capital',
)
eq(
  collateralRequired(BP, 100n * GEN, CREDENT_POLICY),
  25n * GEN,
  'collateralRequired: the discount stops at the floor - nobody works for free',
)
eq(collateralRequired(5000, 0n, CREDENT_POLICY), 0n, 'collateralRequired: no stake, no collateral')
eq(
  collateralRequired(0, maxStake(CREDENT_POLICY), CREDENT_POLICY) <=
    (1n << 256n) - 1n,
  true,
  'maxStake: the largest admissible stake still fits in a u256',
)

// --- receipt outcomes -----------------------------------------------------
//
// Whether a write succeeded is read out of `consensus_data.leader_receipt`, and
// getting it wrong is not a cosmetic failure: it reports a rejected attestation
// to the visitor as a success, or a successful one as rejected.
//
// The shapes below are taken from a real studionet receipt - the `attest` call
// that put the first record on the deployed contract. Two details of that
// receipt are the reason this is pinned. Its `leader_receipt` carried *two*
// entries, a leader that succeeded beside a validator that errored; and its
// top-level `txExecutionResultName` was `undefined`, so the check that once
// tested only that field saw nothing to object to and passed everything.

const leaderEntry = {
  mode: 'leader',
  execution_result: 'SUCCESS',
  result: { status: 'return', payload: { readable: '0' } },
}
const validatorEntry = {
  mode: 'validator',
  execution_result: 'ERROR',
  result: { status: 'contract_error', payload: 'validator disagreed' },
}

// Cast because these are the fields `outcomeOf` reads, not a whole transaction;
// filling in the rest would assert nothing and hide which fields matter.
const receipt = (leader_receipt: unknown[]) =>
  ({ consensus_data: { leader_receipt } }) as unknown as GenLayerTransaction

eq(
  outcomeOf(receipt([leaderEntry, validatorEntry])),
  { ok: true, reason: null, returned: '0' },
  'outcomeOf: the leader decides, and its return value is carried out',
)
// The same receipt with the entries swapped. Reading `[0]` would call this
// successful attestation a rejection; selecting by `mode` is what prevents it.
eq(
  outcomeOf(receipt([validatorEntry, leaderEntry])),
  { ok: true, reason: null, returned: '0' },
  'outcomeOf: a validator listed before the leader does not decide the outcome',
)
eq(
  outcomeOf(
    receipt([
      {
        mode: 'leader',
        execution_result: 'ERROR',
        result: { status: 'contract_error', payload: '[EXPECTED] already_attested' },
      },
    ]),
  ),
  { ok: false, reason: '[EXPECTED] already_attested', returned: null },
  "outcomeOf: a rejection carries the contract's own reason",
)
// No `mode` anywhere is a node that does not label its entries, not a failure.
eq(
  outcomeOf(receipt([{ execution_result: 'SUCCESS', result: { status: 'return', payload: {} } }]))
    .ok,
  true,
  'outcomeOf: an unlabelled single entry falls back to the first',
)
// An empty or unrecognised receipt must not invent a failure that did not happen.
eq(outcomeOf(receipt([])).ok, true, 'outcomeOf: an empty leader_receipt is not a failure')

// --- settlement ------------------------------------------------------------

// Which networks can pay a wallet, checked against every chain the SDK ships
// rather than only the one this build targets. The site tells a visitor whether
// a release, claim, refund or bond reclaim will actually arrive, and it decides
// that from `isStudio` - so a network changing sides here, or a new one arriving
// classified wrongly, would change what the site promises about money. That is
// worth one assertion per network.
eq(settlesToWallet(localnet), false, 'settlement: localnet is a studio network')
eq(settlesToWallet(studionet), false, 'settlement: studionet cannot pay a wallet')
eq(settlesToWallet(testnetAsimov), true, 'settlement: testnet-asimov settles')
eq(settlesToWallet(testnetBradbury), true, 'settlement: testnet-bradbury settles')

// The flag is read, not assumed present. A chain definition that stopped
// carrying `isStudio` would make every network look like it settles, which is
// the failure direction that costs someone money.
eq(
  typeof studionet.isStudio === 'boolean' && typeof testnetAsimov.isStudio === 'boolean',
  true,
  'settlement: the SDK still carries isStudio on its chain definitions',
)

// --- report ---------------------------------------------------------------

if (failures > 0) {
  console.error(`\nunits failed: ${failures} of ${checks} checks`)
  process.exit(1)
}
console.log(
  `units ok - ${checks} checks across formatting, stake parsing, collateral pricing, error text, ` +
    `address encoding, receipt outcomes and settlement support`,
)
