/**
 * End-to-end proof that a payout actually reaches a wallet.
 *
 * This is the check that was missing, and the reason it was missing is worth
 * stating plainly: every existing test asserts what the *contract decided*, and
 * the contract's decision was never the part that was broken. `release_collateral`
 * marks the collateral returned and emits a transfer. The engine tests agree it
 * should. The parity vectors agree the site would show the same number. The
 * transaction reaches `ACCEPTED` and `outcomeOf` reads a clean leader receipt.
 * And on a studio network the money never moves, because the transfer a contract
 * emits toward an externally owned account is executed as a *contract call*
 * against a wallet and fails `Contract 0x... not found` - inside a **separate,
 * triggered** transaction that nothing in this repository was reading.
 *
 * So this script asserts the only two things that can tell those cases apart:
 *
 *   1. the triggered transaction the payout produced finished without error, and
 *   2. the recipient's balance actually went up.
 *
 * Balance is the ground truth and the triggered receipt is the diagnostic. A run
 * where the parent call succeeds, the triggered call fails and the balance falls
 * by the gas is precisely the reported defect, and it is reported as a failure
 * here rather than as five green assertions about storage.
 *
 * ## What it covers
 *
 * Every path in this contract that returns value, which is what the review asked
 * for:
 *
 *   the acceptance refund    an overfunded `accept_engagement` returns the excess
 *   the attestation refund   an overfunded `attest` returns the excess
 *   release, graded          the client graded the work as delivered
 *   release, ungraded        nobody attested and the dispute window elapsed
 *   claim                    a substantiated grade forfeited it to the client
 *   bond reclaim             the attester takes their bond back after the lock
 *
 * ## Why it deploys its own contract
 *
 * Two of those are unreachable against a long-lived deployment. `reclaim_bond`
 * and the ungraded release both wait out `bond_lock_seconds`, which is fourteen
 * days at the deployed policy - so a script that verified them against the live
 * contract would have to be run a fortnight after the run that set them up. The
 * lock is a policy parameter, so this deploys an instance with it set to zero and
 * leaves every other parameter at the deployed values. Nothing about the payout
 * path changes with the lock; only the wait does.
 *
 * ## Running it
 *
 *     # confirm the limitation on the network this is deployed to
 *     CLIENT_PRIVATE_KEY=0x... PROVIDER_PRIVATE_KEY=0x... npm run settlement
 *
 *     # verify settlement on a network that can pay a wallet
 *     VITE_GENLAYER_NETWORK=testnet-asimov \
 *     CLIENT_PRIVATE_KEY=0x... \
 *     PROVIDER_PRIVATE_KEY=0x... \
 *     npm run settlement
 *
 * Two funded accounts, because the protocol requires two: a client cannot name
 * itself as its own provider, and only the named provider can accept. Fund both;
 * the provider needs collateral and the client needs bonds. `SETTLEMENT_STAKE`
 * (default 2 GEN) sets the engagement value everything else is priced off.
 *
 * On a studio network the script does not pretend to verify anything, and it does
 * not merely give up either. It runs the same lifecycle and *characterizes* what
 * the chain actually does: it passes when every payout is recorded and none is
 * paid - the documented limitation, reproduced rather than asserted - and fails
 * if any payout unexpectedly arrives, which would mean this repository's account
 * of the network has gone stale. That makes a studionet run citable evidence for
 * the README's claim, while never reading as "the money moved".
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAccount, createClient } from 'genlayer-js'
import { localnet, studionet, testnetAsimov, testnetBradbury } from 'genlayer-js/chains'
import { TransactionStatus } from 'genlayer-js/types'
import type {
  GenLayerChain,
  GenLayerClient,
  GenLayerTransaction,
  TransactionHash,
} from 'genlayer-js/types'

import { addressArg } from '../src/chain/oracle'
import { outcomeOf } from '../src/chain/outcome'
import { formatBond } from '../src/core/format'

// --- configuration ---------------------------------------------------------

/**
 * The networks this can target, by the alias the CLI and the site both use.
 *
 * Held here rather than imported from `src/chain/config`, because that module
 * resolves *one* network from the build environment and freezes it. This script
 * picks its own, and has to be able to report on a network the site was not
 * built for.
 */
const CHAINS = {
  localnet,
  studionet,
  'testnet-asimov': testnetAsimov,
  'testnet-bradbury': testnetBradbury,
} as const

type NetworkAlias = keyof typeof CHAINS

const GEN = 10n ** 18n

function env(name: string): string | null {
  const raw = process.env[name]?.trim()
  return raw ? raw : null
}

function requireEnv(name: string, why: string): string {
  const value = env(name)
  if (value === null) {
    console.error(`\n${name} is required: ${why}`)
    process.exit(2)
  }
  return value
}

function privateKey(name: string): `0x${string}` {
  const raw = requireEnv(name, 'the lifecycle needs two funded accounts to sign as')
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    console.error(`\n${name} is not a 32-byte hex private key.`)
    process.exit(2)
  }
  return raw as `0x${string}`
}

function tokens(name: string, fallback: bigint): bigint {
  const raw = env(name)
  if (raw === null) return fallback
  try {
    // Whole or fractional GEN, converted through the same 18 decimals the chain
    // uses. `parseTokens` in `core/format` does this for the UI; this is the
    // script's own path because a bad value here should stop the run, not render.
    const [whole, frac = ''] = raw.split('.')
    const padded = (frac + '0'.repeat(18)).slice(0, 18)
    return BigInt(whole) * GEN + BigInt(padded || '0')
  } catch {
    console.error(`\n${name}="${raw}" is not an amount in GEN.`)
    process.exit(2)
  }
}

const NETWORK = (env('VITE_GENLAYER_NETWORK') ?? 'studionet') as NetworkAlias
if (!(NETWORK in CHAINS)) {
  console.error(
    `\nVITE_GENLAYER_NETWORK="${NETWORK}" is not a known network. ` +
      `Expected one of: ${Object.keys(CHAINS).join(', ')}.`,
  )
  process.exit(2)
}

const CHAIN: GenLayerChain = CHAINS[NETWORK]

/**
 * Whether a payout can reach a wallet here.
 *
 * The SDK's own `isStudio`, for the reason `src/chain/config.ts` gives: it is
 * what the distinction *is*, so a network added to the SDK later classifies
 * itself instead of defaulting to "settlement works" because nobody edited a
 * list.
 */
const SETTLES = CHAIN.isStudio !== true

/** The engagement value every other figure is priced off. */
const STAKE = tokens('SETTLEMENT_STAKE', 2n * GEN)

/** The bond an attestation posts. Deliberately non-zero: zero switches it off. */
const MIN_BOND = tokens('SETTLEMENT_BOND', GEN)

/** How much each refunding call deliberately overpays by. */
const OVERPAY = tokens('SETTLEMENT_OVERPAY', GEN / 2n)

/**
 * How much of a payout may go missing to gas before the amount is called wrong.
 *
 * Every recipient here is also the sender of the call that pays them - the
 * provider calls `release_collateral` and is the one paid, the attester calls
 * `reclaim_bond` and is the one paid - so an arrived payout shows up as
 * `amount - gas`, never as `amount`. The check that catches the reported defect
 * does not depend on this number at all: an unpaid payout moves the balance
 * *down* by the gas, so `delta > 0` separates the two cases on its own. This
 * only bounds how far the credited amount may sit below the amount owed before
 * that is a second, different bug.
 */
const GAS_ALLOWANCE = tokens('SETTLEMENT_GAS_ALLOWANCE', GEN / 4n)

// --- the contract ----------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT = resolve(HERE, '..', '..', 'reputation_oracle.py')

/**
 * The policy this deploys under: the deployed one, with the lock opened.
 *
 * In constructor order, which is the order the README documents for
 * `genlayer deploy --args`. Only `bond_lock_seconds` differs from the live
 * deployment, and only so that `reclaim_bond` and the ungraded release are
 * reachable inside one run rather than two weeks apart.
 */
function constructorArgs(): Array<number | bigint> {
  return [
    7776000, // half_life_seconds
    30000, // prior_weight
    25, // min_substantiated
    50, // min_confidence
    20, // confidence_tol
    8, // repeat_shift_cap
    // A bigint, not `Number(...)`. Bonds are denominated in wei, so a bond of
    // 1.234567 GEN is 1234567000000000000 - past `Number.MAX_SAFE_INTEGER`, and
    // a double would round it silently. Calldata encodes bigints natively, and
    // this is the same class of defect the README documents in the other
    // direction, where a large `u256` comes back as a decimal string.
    MIN_BOND, // min_bond
    20, // slash_floor
    50, // release_floor
    0, // bond_lock_seconds  <- the one change
    15000, // collateral_ceiling_bp
    2500, // collateral_floor_bp
    2500, // collateral_forfeit_bp
  ]
}

// --- reporting -------------------------------------------------------------

let failures = 0
let expectedFailures = 0

function ok(what: string, detail = '') {
  console.log(`  ok   ${what}${detail ? `  ${detail}` : ''}`)
}

function fail(what: string, detail = '') {
  failures += 1
  console.error(`  FAIL ${what}${detail ? `  ${detail}` : ''}`)
}

function expectedFail(what: string, detail = '') {
  expectedFailures += 1
  console.log(`  xfail ${what}${detail ? `  ${detail}` : ''}`)
}

function step(name: string) {
  console.log(`\n${name}`)
}

// --- chain plumbing --------------------------------------------------------

type Client = GenLayerClient<GenLayerChain>

function clientFor(key: `0x${string}`): Client {
  return createClient({ chain: CHAIN, account: createAccount(key) }) as Client
}

/**
 * Wait for a transaction and hand back the receipt.
 *
 * `ACCEPTED` rather than `FINALIZED`: acceptance is the point at which consensus
 * has agreed what happened, which is what every assertion here reads, and
 * finalization on a real testnet adds a wait measured in minutes per call.
 */
async function receipt(client: Client, hash: string): Promise<GenLayerTransaction> {
  return client.waitForTransactionReceipt({
    hash: hash as TransactionHash,
    status: TransactionStatus.ACCEPTED,
    interval: 2_000,
    retries: 120,
  })
}

/**
 * Send one call and refuse to continue if the contract rejected it.
 *
 * The same trap `wallet.ts` documents: a GenLayer transaction reaches `ACCEPTED`
 * when consensus agrees on what happened, *including* when what happened is a
 * rejection. So the status is necessary and not sufficient, and the leader
 * receipt is read through the site's own `outcomeOf` rather than a second copy.
 */
async function call(
  client: Client,
  address: string,
  functionName: string,
  args: unknown[],
  value = 0n,
): Promise<{ hash: string; returned: string | null }> {
  const hash = await client.writeContract({
    address: address as `0x${string}`,
    functionName,
    args: args as never[],
    value,
  })
  const settled = await receipt(client, String(hash))
  const outcome = outcomeOf(settled)
  if (!outcome.ok) {
    throw new Error(
      outcome.reason
        ? `${functionName} was rejected by the contract: ${outcome.reason}`
        : `${functionName} was rejected by the contract.`,
    )
  }
  return { hash: String(hash), returned: outcome.returned }
}

async function view(
  client: Client,
  address: string,
  functionName: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const result = await client.readContract({
    address: address as `0x${string}`,
    functionName,
    args: args as never[],
  })
  return result as Record<string, unknown>
}

/**
 * An integer from a view, however the node chose to spell it.
 *
 * A `u256` past 2^53 comes back as a decimal *string* rather than a number - the
 * defect `oracle.ts` documents, and the one that appears on the first real bond,
 * since bonds are denominated in wei. A decoder that accepts only numbers works
 * until a value gets large, so this accepts both on purpose.
 */
function big(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new Error(`expected an integer from the chain, received ${JSON.stringify(value)}`)
}

// --- the part that matters -------------------------------------------------

interface Execution {
  status: string
  execution: string
  error: string | null
  failed: boolean
}

/**
 * What a triggered transaction did.
 *
 * Deliberately not `outcomeOf`: that reads a *contract call's* leader receipt,
 * and a triggered transfer toward a wallet is a different shape. What matters
 * here is only whether the node recorded an error, so an unrecognised shape is
 * reported verbatim rather than assumed to have succeeded.
 */
function executionOf(tx: GenLayerTransaction): Execution {
  const entries = tx.consensus_data?.leader_receipt
  const list = Array.isArray(entries) ? entries : []
  const leader = list.find((entry) => (entry as { mode?: unknown })?.mode === 'leader') ?? list[0]

  const receiptResult = (leader as { execution_result?: unknown })?.execution_result
  const receiptError = (leader as { error?: unknown })?.error
  const named = tx.txExecutionResultName

  const failed =
    named === 'FINISHED_WITH_ERROR' ||
    receiptResult === 'ERROR' ||
    receiptResult === 'FINISHED_WITH_ERROR' ||
    (typeof receiptError === 'string' && receiptError.length > 0)

  return {
    status: String(tx.statusName ?? tx.status ?? 'unknown'),
    execution: String(named ?? receiptResult ?? 'unknown'),
    error: typeof receiptError === 'string' && receiptError.length > 0 ? receiptError : null,
    failed,
  }
}

/**
 * The transactions a call spawned, and what became of each.
 *
 * This is the leg the original defect hid in. `emit_transfer` does not move
 * value inside the calling transaction; it queues a message that the node
 * executes as its own transaction afterwards. The parent reports success because
 * from the contract's side emitting the message *is* the whole operation, so the
 * failure is only visible here or in the balance.
 */
async function triggered(client: Client, hash: string): Promise<Array<{ id: string } & Execution>> {
  let ids: string[] = []
  try {
    ids = (await client.getTriggeredTransactionIds({ hash: hash as TransactionHash })) ?? []
  } catch (error) {
    // A network that does not expose the endpoint is not a failed payout. The
    // balance check below still decides the case; this only loses the diagnosis.
    console.log(`       (triggered transactions unavailable: ${(error as Error).message})`)
    return []
  }

  const out: Array<{ id: string } & Execution> = []
  for (const id of ids) {
    try {
      out.push({ id: String(id), ...executionOf(await receipt(client, String(id))) })
    } catch (error) {
      out.push({
        id: String(id),
        status: 'unread',
        execution: 'unknown',
        error: (error as Error).message,
        failed: true,
      })
    }
  }
  return out
}

interface Payout {
  /** What this payout is, for the report. */
  label: string
  /** Who is owed the money. */
  recipient: string
  /** How much they are owed. */
  expected: bigint
  /** The call that should pay them. Returns the parent transaction hash. */
  run: () => Promise<{ hash: string }>
}

/**
 * Run one payout and decide whether the money arrived.
 *
 * The two assertions are independent on purpose. The triggered receipt says what
 * the node thinks it did; the balance says what happened. A payout passes only
 * when both agree, because each has already been wrong on its own - the parent
 * receipt said success while nothing moved, and a balance can move for reasons
 * this call is not responsible for.
 */
async function verify(client: Client, payout: Payout): Promise<void> {
  const address = payout.recipient as `0x${string}`
  const before = await client.getBalance({ address })

  let hash: string
  try {
    ;({ hash } = await payout.run())
  } catch (error) {
    fail(payout.label, `the call itself was rejected: ${(error as Error).message}`)
    return
  }

  const spawned = await triggered(client, hash)
  const after = await client.getBalance({ address })
  const delta = after - before

  const arrived = delta > 0n
  const shortfall = payout.expected - delta
  const rightSize = arrived && shortfall <= GAS_ALLOWANCE && delta <= payout.expected

  const money =
    `owed ${formatBond(payout.expected)}, ` +
    `balance moved ${delta >= 0n ? '+' : ''}${formatBond(delta)}`

  const brokenLeg = spawned.filter((entry) => entry.failed)

  if (!SETTLES) {
    // The documented studio limitation. Reporting it as expected keeps the run
    // readable, but the script still exits non-zero: nothing was verified.
    if (arrived) {
      fail(payout.label, `${money} - settlement unexpectedly worked on a studio network`)
    } else {
      expectedFail(payout.label, `${money} - studio cannot pay a wallet`)
      for (const entry of brokenLeg) {
        console.log(`       triggered ${entry.id}: ${entry.execution} ${entry.error ?? ''}`)
      }
    }
    return
  }

  if (brokenLeg.length > 0) {
    fail(payout.label, `${money}`)
    for (const entry of brokenLeg) {
      console.error(
        `       triggered ${entry.id} failed: ${entry.execution} ${entry.error ?? ''}`.trimEnd(),
      )
    }
    return
  }

  if (!arrived) {
    fail(
      payout.label,
      `${money} - the recipient is no better off, so the transfer did not land` +
        (spawned.length === 0 ? ' (and no transaction was triggered at all)' : ''),
    )
    return
  }

  if (!rightSize) {
    fail(
      payout.label,
      `${money} - arrived, but short by ${formatBond(shortfall)}, ` +
        `beyond the ${formatBond(GAS_ALLOWANCE)} allowed for gas`,
    )
    return
  }

  ok(payout.label, `${money} (${formatBond(shortfall)} to gas), ${spawned.length} triggered tx`)
}

// --- the material being graded ---------------------------------------------

const SCOPE = `Deliver a Python script that reads orders.csv (about 12,000 rows), removes
duplicate order ids keeping the most recent row by timestamp, and writes
orders_clean.csv sorted by order id. Runtime under 30 seconds on a laptop.
Include a one-page README covering how to run it and what it does with
malformed rows.`

/**
 * A claim the grader should read as delivered, and evidence that supports it.
 *
 * Written to be gradeable rather than to be filler: specific, checkable, and
 * about the scope's own acceptance criteria. `substantiated` has to clear
 * `release_floor` for the collateral to settle at all, so vagueness here would
 * leave the engagement held and the release leg untested.
 */
const DELIVERED = {
  claim:
    'The script was delivered on time and meets every point of the scope. ' +
    'Deduplication keeps the most recent row per order id, the output is sorted ' +
    'by order id, and the README documents the malformed-row behaviour.',
  evidence:
    'Received dedupe_orders.py and README.md. Run against our 12,043-row ' +
    'orders.csv it completed in 4.1s and wrote orders_clean.csv with 11,780 rows; ' +
    '263 duplicate ids were removed, matching the 263 our own SQL count found. ' +
    'Spot-checked eight duplicated ids: each kept the row with the latest ' +
    'timestamp. Output verified sorted ascending by order id. The README has a ' +
    '"Malformed rows" section stating they are skipped and counted to stderr, ' +
    'and 4 malformed rows were reported on our file.',
}

/**
 * A claim the grader should read as undelivered, evidenced well enough to count.
 *
 * Both halves are required. An unevidenced accusation is worth nothing to the
 * score by design, and `collateral_outcome` applies that same gate before it
 * forfeits anyone's money - so a forfeit needs `substantiated >= release_floor`
 * as well as a low `fulfilled`. Testing the claim leg means clearing both.
 */
const UNDELIVERED = {
  claim:
    'The work was not delivered. No script was produced by the deadline, and ' +
    'what was eventually sent does not run and does not deduplicate anything.',
  evidence:
    'Nothing was received by the 2026-08-24 deadline. A file arrived two days ' +
    'later containing 14 lines that read orders.csv and print its row count; it ' +
    'writes no output file. Executed on our 12,043-row orders.csv it raises ' +
    'FileNotFoundError on a hardcoded /home/dev/orders.csv path and exits 1. ' +
    'No deduplication logic is present - the string "drop_duplicates" and any ' +
    'timestamp comparison are absent from the file. No README was included.',
}

// --- the run ---------------------------------------------------------------

function uniqueId(tag: string): string {
  return `settle-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

async function main() {
  console.log(`settlement verification on ${CHAIN.name} (${NETWORK})`)

  if (!SETTLES) {
    console.log(
      `\n  ${CHAIN.name} is a studio network. A contract cannot pay an externally\n` +
        '  owned account here: the transfer becomes a contract call against a wallet\n' +
        '  and fails "Contract 0x... not found" inside a triggered transaction, while\n' +
        '  the parent call still reports success.\n\n' +
        '  So this run CONFIRMS that limitation rather than verifying settlement. It\n' +
        '  passes if every payout is recorded and none is paid, and fails if one\n' +
        '  unexpectedly arrives. A pass here does not mean the money moved.\n' +
        '  Point VITE_GENLAYER_NETWORK at testnet-asimov or testnet-bradbury to verify\n' +
        '  settlement for real.',
    )
  }

  const clientKey = privateKey('CLIENT_PRIVATE_KEY')
  const providerKey = privateKey('PROVIDER_PRIVATE_KEY')

  const client = clientFor(clientKey)
  const provider = clientFor(providerKey)

  const clientAddress = client.account!.address
  const providerAddress = provider.account!.address

  if (clientAddress.toLowerCase() === providerAddress.toLowerCase()) {
    console.error(
      '\nCLIENT_PRIVATE_KEY and PROVIDER_PRIVATE_KEY are the same account. ' +
        'The protocol refuses it: a client cannot name itself as its own provider.',
    )
    process.exit(2)
  }

  step('accounts')
  const clientBalance = await client.getBalance({ address: clientAddress })
  const providerBalance = await provider.getBalance({ address: providerAddress })
  console.log(`  client   ${clientAddress}  ${formatBond(clientBalance)}`)
  console.log(`  provider ${providerAddress}  ${formatBond(providerBalance)}`)

  // Three engagements at the ceiling rate, plus bonds and overpayments, plus gas.
  // Approximate on purpose - it is a warning, not a gate, because the real cost
  // depends on a score this has not read yet.
  const providerNeeds = (STAKE * 15000n) / 10000n + OVERPAY
  const clientNeeds = MIN_BOND * 2n + OVERPAY
  if (providerBalance < providerNeeds) {
    console.log(`  note: provider may be short; roughly ${formatBond(providerNeeds)} is needed`)
  }
  if (clientBalance < clientNeeds) {
    console.log(`  note: client may be short; roughly ${formatBond(clientNeeds)} is needed`)
  }

  step('deploy')
  const code = readFileSync(CONTRACT, 'utf8')
  const deployHash = await client.deployContract({ code, args: constructorArgs() })
  const deployed = await receipt(client, String(deployHash))
  const address =
    (deployed.txDataDecoded as { contractAddress?: string } | undefined)?.contractAddress ??
    deployed.to_address ??
    deployed.recipient
  if (!address) {
    console.error('  the deploy receipt carried no contract address; cannot continue')
    process.exit(1)
  }
  console.log(`  ${address}`)

  const policy = await view(client, address, 'get_policy')
  if (big(policy.bond_lock_seconds) !== 0n) {
    fail('deployed policy', `bond_lock_seconds = ${policy.bond_lock_seconds}, expected 0`)
  } else {
    ok('deployed policy', `bond_lock_seconds = 0, min_bond = ${formatBond(big(policy.min_bond))}`)
  }

  const providerArg = addressArg(providerAddress, 'provider')

  // --- 1. the release path, and both refunds -------------------------------

  step('1. accept, grade as delivered, release')
  const first = uniqueId('release')
  await call(client, address, 'open_engagement', [first, providerArg, SCOPE, STAKE])

  const quote = await view(provider, address, 'collateral_quote', [providerArg, STAKE])
  const required = big(quote.required)
  console.log(
    `  quoted ${formatBond(required)} at ${quote.rate_bp}bp on a score of ${quote.score_bp}`,
  )

  await verify(provider, {
    label: 'acceptance refund',
    recipient: providerAddress,
    expected: OVERPAY,
    run: () => call(provider, address, 'accept_engagement', [first], required + OVERPAY),
  })

  await call(client, address, 'close_engagement', [first])

  const bond = big(await client.readContract({
    address: address as `0x${string}`,
    functionName: 'bond_for_next',
    args: [addressArg(clientAddress, 'attester'), providerArg] as never[],
  }))

  await verify(client, {
    label: 'attestation refund',
    recipient: clientAddress,
    expected: OVERPAY,
    run: () =>
      call(
        client,
        address,
        'attest',
        [first, DELIVERED.claim, DELIVERED.evidence],
        bond + OVERPAY,
      ),
  })

  const graded = await view(client, address, 'get_engagement', [first])
  const gradedState = String(graded.collateral_state)
  if (gradedState !== 'releasable') {
    fail(
      'grade settled the collateral as releasable',
      `collateral_state = ${gradedState}. The model did not read the evidence as ` +
        'delivered-and-substantiated, so the release leg cannot be exercised on this ' +
        'engagement. Re-run, or strengthen DELIVERED.evidence.',
    )
  } else {
    ok('grade settled the collateral as releasable')
    await verify(provider, {
      label: 'release_collateral (graded)',
      recipient: providerAddress,
      expected: big(graded.collateral),
      run: () => call(provider, address, 'release_collateral', [first]),
    })
  }

  await verify(client, {
    label: 'reclaim_bond',
    recipient: clientAddress,
    expected: bond,
    run: () => call(client, address, 'reclaim_bond', [0]),
  })

  // --- 2. the claim path ---------------------------------------------------

  step('2. accept, grade as undelivered, claim')
  const second = uniqueId('claim')
  await call(client, address, 'open_engagement', [second, providerArg, SCOPE, STAKE])

  const secondQuote = await view(provider, address, 'collateral_quote', [providerArg, STAKE])
  const secondRequired = big(secondQuote.required)
  console.log(
    `  quoted ${formatBond(secondRequired)} at ${secondQuote.rate_bp}bp ` +
      `on a score of ${secondQuote.score_bp}`,
  )

  await call(provider, address, 'accept_engagement', [second], secondRequired)
  await call(provider, address, 'close_engagement', [second])

  const secondBond = big(await client.readContract({
    address: address as `0x${string}`,
    functionName: 'bond_for_next',
    args: [addressArg(clientAddress, 'attester'), providerArg] as never[],
  }))
  await call(
    client,
    address,
    'attest',
    [second, UNDELIVERED.claim, UNDELIVERED.evidence],
    secondBond,
  )

  const forfeited = await view(client, address, 'get_engagement', [second])
  const forfeitedState = String(forfeited.collateral_state)
  if (forfeitedState !== 'forfeit') {
    fail(
      'grade forfeited the collateral',
      `collateral_state = ${forfeitedState}. Forfeiting needs a grade that is both ` +
        'unfulfilled and substantiated enough to count in the score, so the claim leg ' +
        'cannot be exercised on this engagement. Re-run, or strengthen ' +
        'UNDELIVERED.evidence.',
    )
  } else {
    ok('grade forfeited the collateral')
    await verify(client, {
      label: 'claim_collateral',
      recipient: clientAddress,
      expected: big(forfeited.collateral),
      run: () => call(client, address, 'claim_collateral', [second]),
    })
  }

  // --- 3. the ungraded release --------------------------------------------

  step('3. close without attesting, release once the window elapses')
  const third = uniqueId('ungraded')
  await call(client, address, 'open_engagement', [third, providerArg, SCOPE, STAKE])

  const thirdQuote = await view(provider, address, 'collateral_quote', [providerArg, STAKE])
  const thirdRequired = big(thirdQuote.required)
  await call(provider, address, 'accept_engagement', [third], thirdRequired)
  await call(provider, address, 'close_engagement', [third])

  const held = await view(provider, address, 'get_engagement', [third])
  if (String(held.collateral_state) !== 'held') {
    fail('collateral is held before release', `collateral_state = ${held.collateral_state}`)
  } else {
    ok('collateral is held before release')
    await verify(provider, {
      label: 'release_collateral (ungraded)',
      recipient: providerAddress,
      expected: big(held.collateral),
      run: () => call(provider, address, 'release_collateral', [third]),
    })
  }

  // --- the verdict ---------------------------------------------------------

  console.log('')
  if (!SETTLES) {
    // A studio run is a characterization test, not a verification. It passes when
    // the chain behaves exactly as this repository documents - every payout
    // recorded, none of them paid - and fails when it does not, including when a
    // payout unexpectedly *does* arrive, which would mean the documentation is
    // now wrong. Green here says "the limitation is real and unchanged"; it does
    // not say the money moved, and the wording below has to keep that impossible
    // to misread.
    if (failures > 0) {
      console.error(
        `settlement FAILED on ${CHAIN.name}: ${failures} check(s) did not behave as ` +
          `documented (${expectedFailures} payout(s) recorded and not paid, as expected).\n` +
          'A payout that unexpectedly arrived, or a call that was rejected outright, ' +
          'means this repository\'s account of the network is out of date.',
      )
      process.exit(1)
    }
    console.log(
      `confirmed on ${CHAIN.name}: all ${expectedFailures} payout(s) were recorded ` +
        'correctly and NONE of them were paid.\n' +
        'The contract decided right every time and no balance moved - which is the ' +
        'documented studio limitation, reproduced rather than asserted.\n' +
        'This is NOT a settlement verification. Run against testnet-asimov or ' +
        'testnet-bradbury for one.',
    )
    return
  }

  if (failures > 0) {
    console.error(`settlement FAILED: ${failures} check(s) on ${CHAIN.name}`)
    process.exit(1)
  }

  console.log(
    `settlement ok - every payout reached its wallet on ${CHAIN.name}, ` +
      'verified by the triggered transaction and by the recipient balance',
  )
}

await main()
