/**
 * Proof that settlement moves money, not merely that it records having done so.
 *
 * This is the check the project was missing, and the gap it was missing let a
 * whole class of failure ship. Every other test here reasons about state: the
 * engine agrees with its port, the decoders read what the node sends,
 * `livecheck` confirms the deployed contract answers its views with the numbers
 * the site expects. Not one of them asks the only question that matters to
 * somebody whose collateral is in the contract - *did the balance move?*
 *
 * On studionet it never did. `gl.get_contract_at(addr).emit_transfer(value=...)`
 * dispatches a message to the recipient, studio routes that message as a
 * contract call, finds no code at a wallet address, and answers
 * `contract_not_found_handler` - "Contract 0x... not found" - with
 * `value_credited: false`. The parent transaction FINALIZEs regardless, so the
 * contract had already written `_COL_RETURNED` and the site truthfully reported
 * a settlement that never happened. Four different spellings of the transfer
 * were tried against studionet and all four failed identically; the simulator
 * documents no support for token transfers at all. So this script exists to fail
 * loudly on any network where that is still true.
 *
 * ## What it asserts, and why it is shaped this way
 *
 * The recipient of every payout here is also the account that sent the
 * transaction asking for it, so their balance moves by `amount - gas` and no
 * exact assertion can be written against it. The contract pays no gas, which
 * makes *its* balance the gas-free oracle of truth. So each settlement is
 * checked twice:
 *
 *   - the contract's balance falls by exactly the amount it recorded, and
 *   - the recipient's balance strictly rises.
 *
 * The first pins the number. The second is what studionet cannot pass: under the
 * defect the recipient comes out behind by the gas they spent asking, so
 * `delta > 0` is precisely the line between a settlement and a receipt for one.
 *
 * ## Locks
 *
 * `bond_lock_seconds` is a constructor argument, so this deploys its own
 * instance with the lock at zero rather than waiting out the fourteen days the
 * production policy imposes. That is the only policy difference from a real
 * deployment, and it is what makes `reclaim_bond` and the unattested
 * `release_collateral` path reachable in a single pass.
 *
 * ## Running it
 *
 *   CREDENT_KEYDIR=/path/outside/the/repo \
 *   VITE_GENLAYER_NETWORK=testnet-asimov \
 *   npm run settlement
 *
 * Needs two funded accounts and sends real transactions, so it is not part of
 * CI. `CREDENT_KEYDIR` holds `client.key` and `provider.key` as raw hex, outside
 * the repository; nothing here prints key material.
 */

import { readFileSync } from 'node:fs'
import { createAccount, createClient } from 'genlayer-js'
import { TransactionStatus } from 'genlayer-js/types'
import type { GenLayerTransaction } from 'genlayer-js/types'

import { CHAIN, CONFIG_ERROR, EXPLORER_URL, NETWORK } from '../src/chain/config'
import { addressArg } from '../src/chain/oracle'
import { outcomeOf } from '../src/chain/wallet'
import { startGasProxy } from './gasProxy'

/**
 * Refuse to run against a network nobody asked for.
 *
 * `readNetwork` reports an unusable `VITE_GENLAYER_NETWORK` rather than throwing
 * and falls back to studionet, which is right for the site - a bad environment
 * variable should render a message, not a white screen - and catastrophic here.
 * This script's entire purpose is to say whether a *particular* network settles,
 * so a silent fallback makes it answer confidently about the wrong one.
 *
 * That is not hypothetical. The first run of this script reported three
 * settlement failures that were real failures of studionet and nothing to do
 * with the network it had been pointed at: npm runs scripts through `cmd.exe` on
 * Windows, `$VITE_GENLAYER_NETWORK` was never expanded, and the literal string
 * fell through to the default. Every number in that report was true and the
 * conclusion it invited was false.
 */
if (CONFIG_ERROR !== null) {
  console.error(`Refusing to run: ${CONFIG_ERROR}`)
  process.exit(2)
}

// --- reporting ------------------------------------------------------------

let failures = 0
let checks = 0

function check(condition: boolean, what: string): boolean {
  checks += 1
  if (condition) {
    console.log(`    ok   ${what}`)
  } else {
    failures += 1
    console.error(`    FAIL ${what}`)
  }
  return condition
}

const GEN = 10n ** 18n

/** Wei as a readable GEN figure, keeping the exact value beside it. */
function gen(wei: bigint): string {
  const negative = wei < 0n
  const abs = negative ? -wei : wei
  const whole = abs / GEN
  const frac = (abs % GEN).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} GEN`
}

/** A signed delta, always carrying its sign so a zero move reads as a zero move. */
function delta(wei: bigint): string {
  return wei > 0n ? `+${gen(wei)}` : gen(wei)
}

// --- chain ----------------------------------------------------------------

const RPC = CHAIN.rpcUrls.default.http[0]
if (!RPC) throw new Error(`${NETWORK} carries no RPC URL`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One RPC call, retried through transport failures but not through refusals.
 *
 * The retry is not defensive padding. This script sends real value and then
 * watches for it to arrive, polling for minutes at a time, so a single dropped
 * connection partway through would abort a run that had already moved money and
 * report it as a failure of the contract rather than of the socket - `ECONNRESET`
 * off these endpoints is common enough to have interrupted a balance read while
 * this was being written.
 *
 * A JSON-RPC *error* is not retried. A malformed address or a missing method
 * fails identically however many times it is asked, and retrying it turns one
 * clear diagnosis into three slow ones.
 */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await response.json()) as { result?: unknown; error?: unknown }
      if (body.result === undefined) {
        throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body)}`)
      }
      return body.result
    } catch (cause) {
      last = cause
      const transport = cause instanceof TypeError || (cause as Error)?.name === 'TimeoutError'
      if (!transport) throw cause
      await sleep(2 ** attempt * 1000)
    }
  }
  throw last
}

async function balanceOf(address: string): Promise<bigint> {
  const raw = await rpc('eth_getBalance', [address, 'latest'])
  if (typeof raw !== 'string') throw new Error(`eth_getBalance returned ${JSON.stringify(raw)}`)
  return BigInt(raw)
}

/**
 * How long to wait for a payout to land before calling it a failure.
 *
 * Generous on purpose, and the generosity is the point. A payout is posted on
 * *finalization*, not on acceptance, so it lands well after the receipt that
 * authorised it - and optimistic-democracy finalization is not a fixed cost. Too
 * short a deadline here produces the one result worse than no test at all: a
 * network that settles correctly, reported as a network that does not, which
 * would be read as confirming the very defect this script exists to detect.
 *
 * A run that has genuinely failed still terminates - it just takes ten minutes
 * to say so, which is a fair price for never crying wolf.
 */
/**
 * How long to wait for a payout to land, in milliseconds.
 *
 * Ten minutes was the original figure and it is wrong on any network where
 * payouts post on *finalization* rather than on acceptance. Bradbury finalizes
 * against a 24h minimum epoch (`genlayer staking epoch-info`), so a settlement
 * opened just after a rotation cannot possibly be observed inside ten minutes,
 * and the harness would report a working transfer as a timeout - a false red
 * every bit as misleading as studionet's false green.
 *
 * The default is deliberately longer than one epoch. Override it for a fast
 * network rather than editing this: `SETTLE_TIMEOUT_MS=600000 npm run settlement`.
 */
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 26 * 60 * 60 * 1000)
if (!Number.isFinite(SETTLE_TIMEOUT_MS) || SETTLE_TIMEOUT_MS <= 0) {
  console.error(`SETTLE_TIMEOUT_MS must be a positive number of ms; got ${process.env.SETTLE_TIMEOUT_MS}`)
  process.exit(2)
}

/**
 * Wait for a balance to satisfy `settled`, or give up.
 *
 * Polling rather than sleeping a fixed interval keeps a fast network fast and
 * still gives a slow one room. Progress is printed while waiting because ten
 * minutes of silence is indistinguishable from a hang, and someone watching this
 * needs to be able to tell those apart.
 */
async function settleTo(
  address: string,
  settled: (value: bigint) => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<bigint> {
  const started = Date.now()
  const deadline = started + timeoutMs
  let current = await balanceOf(address)
  let announced = 0

  while (!settled(current) && Date.now() < deadline) {
    await sleep(5_000)
    const waited = Math.floor((Date.now() - started) / 1000)
    if (waited - announced >= 30) {
      announced = waited
      console.log(`         ...waiting for finalization (${waited}s, ${gen(current)} so far)`)
    }
    current = await balanceOf(address)
  }
  return current
}

// --- accounts -------------------------------------------------------------

const KEYDIR = process.env.CREDENT_KEYDIR
if (!KEYDIR) {
  console.error(
    'Set CREDENT_KEYDIR to a directory outside the repository holding client.key\n' +
      'and provider.key as raw hex private keys. Nothing here prints key material.',
  )
  process.exit(2)
}

/**
 * Where the SDK sends its requests.
 *
 * The gas shim's address once it is up (see `gasProxy.ts`), and the network's
 * own until then. Balance reads deliberately keep using `RPC` directly - they
 * involve no gas, and reading them straight from the network keeps the numbers
 * this script reports free of anything it did to the traffic.
 */
let endpoint = RPC

function role(name: 'client' | 'provider') {
  const key = readFileSync(`${KEYDIR}/${name}.key`, 'utf8').trim()
  const account = createAccount(key as `0x${string}`)
  return {
    name,
    account,
    address: account.address as string,
    client: createClient({ chain: CHAIN, account, endpoint }),
  }
}

type Role = ReturnType<typeof role>

// --- writing --------------------------------------------------------------

interface Sent {
  hash: string
  returned: string | null
  receipt: GenLayerTransaction
}

/**
 * Send one call, wait for consensus, and insist the contract actually accepted it.
 *
 * Acceptance is necessary and not sufficient - a GenLayer transaction reaches
 * ACCEPTED when consensus agrees on what happened, including agreeing that the
 * contract rejected the call. `outcomeOf` is imported from the site's own wallet
 * module rather than reimplemented, because a second copy of that receipt
 * decoding is how the "accepted therefore fine" bug comes back on the side
 * nobody re-tested.
 */
async function send(
  who: Role,
  address: string,
  functionName: string,
  args: unknown[],
  value = 0n,
): Promise<Sent> {
  const hash = await who.client.writeContract({
    address: address as `0x${string}`,
    functionName,
    args: args as never[],
    value,
  })
  const receipt = await who.client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 100,
  })
  const outcome = outcomeOf(receipt)
  if (!outcome.ok) {
    throw new Error(
      `${functionName} rejected by the contract${outcome.reason ? `: ${outcome.reason}` : ''}`,
    )
  }
  return { hash: String(hash), returned: outcome.returned, receipt }
}

/** A view, read without an account. */
async function view(address: string, functionName: string, args: unknown[] = []): Promise<unknown> {
  return createClient({ chain: CHAIN, endpoint }).readContract({
    address: address as `0x${string}`,
    functionName,
    args: args as never[],
  })
}

function field(source: unknown, key: string): unknown {
  return (source as Record<string, unknown> | null)?.[key]
}

function asBig(raw: unknown, what: string): bigint {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw)
  throw new Error(`${what}: expected an integer, received ${JSON.stringify(raw)}`)
}

// --- the settlement assertion --------------------------------------------

/**
 * Run one payout and prove it landed.
 *
 * `amount` is what the contract recorded as owed. The contract's balance must
 * fall by exactly that - it pays no gas, so there is nothing to subtract - and
 * the recipient's must strictly rise, which is the assertion studionet fails:
 * there the transfer errors after the state is written, leaving the recipient
 * down by the gas they spent asking for their own money.
 */
async function settlement(
  label: string,
  oracle: string,
  recipient: Role,
  amount: bigint,
  act: () => Promise<Sent>,
): Promise<void> {
  console.log(`\n  ${label}`)
  console.log(`    owed ${gen(amount)} to ${recipient.name} ${recipient.address}`)

  const contractBefore = await balanceOf(oracle)
  const recipientBefore = await balanceOf(recipient.address)

  const sent = await act()
  console.log(`    tx   ${sent.hash}`)
  if (EXPLORER_URL) console.log(`         ${EXPLORER_URL}/tx/${sent.hash}`)

  // The contract's balance is what settles first and settles exactly, so it is
  // what the wait keys on. Falling back to a plain read after the timeout means
  // a network that never pays produces a reported delta of zero rather than a
  // hang with no diagnosis.
  const contractAfter = await settleTo(oracle, (value) => value <= contractBefore - amount)
  const recipientAfter = await balanceOf(recipient.address)

  const contractDelta = contractAfter - contractBefore
  const recipientDelta = recipientAfter - recipientBefore

  console.log(`    contract  ${gen(contractBefore)} -> ${gen(contractAfter)}  (${delta(contractDelta)})`)
  console.log(`    ${recipient.name.padEnd(9)} ${gen(recipientBefore)} -> ${gen(recipientAfter)}  (${delta(recipientDelta)})`)

  check(contractDelta === -amount, `the contract paid out exactly ${gen(amount)}`)
  const arrived = check(recipientDelta > 0n, `${recipient.name}'s balance rose (${delta(recipientDelta)})`)
  if (arrived) {
    // What the recipient spent to collect. Not asserted - gas is the network's
    // business - but printed, because a payout that costs more than it pays is
    // worth seeing even when it technically succeeds.
    console.log(`    gas  ${gen(amount - recipientDelta)}`)
  } else {
    console.error(
      `    -> the contract recorded this settlement and the money did not move.\n` +
        `       This is the studionet failure: the transfer is dispatched as a call\n` +
        `       to a wallet that holds no code, errors, and is never credited.`,
    )
  }
}

/**
 * Prove an overpayment came back.
 *
 * Same idea inverted: the contract must end up holding exactly what it was owed
 * and not a wei more, so the excess is checked at the contract rather than at
 * the sender, whose balance is confounded by gas.
 */
async function refund(
  label: string,
  oracle: string,
  sender: Role,
  kept: bigint,
  excess: bigint,
  act: () => Promise<Sent>,
): Promise<Sent> {
  console.log(`\n  ${label}`)
  console.log(
    `    ${sender.name} sends ${gen(kept + excess)}, of which ${gen(excess)} must come back`,
  )

  const contractBefore = await balanceOf(oracle)
  const sent = await act()
  console.log(`    tx   ${sent.hash}`)

  // Settles down to `kept` once the refund lands; without a refund it sticks at
  // `kept + excess`, which is the failure this is looking for.
  const contractAfter = await settleTo(oracle, (value) => value <= contractBefore + kept)
  const contractDelta = contractAfter - contractBefore

  console.log(`    contract  ${gen(contractBefore)} -> ${gen(contractAfter)}  (${delta(contractDelta)})`)
  check(
    contractDelta === kept,
    `the contract kept exactly ${gen(kept)} and refunded ${gen(excess)}`,
  )
  return sent
}

// --- the run --------------------------------------------------------------

/**
 * A policy tuned so one pass can reach every settlement.
 *
 * Positional, because the constructor is. Only two values differ from the
 * contract's own defaults: the bond lock drops to zero so `reclaim_bond` and the
 * unattested `release_collateral` path are reachable now rather than in a
 * fortnight, and `min_bond` is small so a full run costs little. Everything else
 * is the deployed policy, so the collateral arithmetic under test is the real
 * one.
 */
const POLICY = [
  7776000n, // half_life_seconds
  30000n, // prior_weight
  25n, // min_substantiated
  50n, // min_confidence
  20n, // confidence_tol
  8n, // repeat_shift_cap
  GEN / 100n, // min_bond - 0.01 GEN
  20n, // slash_floor
  50n, // release_floor
  0n, // bond_lock_seconds - the one change that makes this runnable in one pass
  15000n, // collateral_ceiling_bp
  2500n, // collateral_floor_bp
  2500n, // collateral_forfeit_bp
]

const SCOPE =
  'Deliver a Python script that reads orders.csv (about 12,000 rows), removes ' +
  'duplicate order ids keeping the most recent row by timestamp, and writes ' +
  'orders_clean.csv sorted by order id. Runtime under 30 seconds on a laptop. ' +
  'Include a one-page README covering how to run it and what it does with ' +
  'malformed rows.'

/**
 * The deployed contract's address, whatever shape the network answers in.
 *
 * Studio networks answer `data.contract_address`. Bradbury - `isStudio=false` -
 * does not carry that key at all; its receipt is
 * `id, txOrigin, sender, recipient, activator, status, ..., roundData`, and the
 * new contract arrives as `recipient`. Reading only the studio spelling made a
 * *successful* deploy throw "deploy returned no contract address", which is the
 * worst kind of wrong: it blames the network for the reader's assumption. The
 * zero-address guard matters because a rejected deploy answers a well-formed
 * receipt whose recipient is 0x0, and that must not read as an address.
 */
function deployedAddress(receipt: unknown): string | undefined {
  const r = receipt as Record<string, any>
  const found =
    r?.data?.contract_address ??
    r?.contract_address ??
    r?.recipient ??
    r?.txDataDecoded?.contract_address
  if (typeof found !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(found)) return undefined
  return /^0x0{40}$/i.test(found) ? undefined : found
}

async function main(): Promise<void> {
  const client = role('client')
  const provider = role('provider')

  console.log(`network   ${NETWORK} (chain ${CHAIN.id})`)
  console.log(`rpc       ${RPC}`)
  console.log(`client    ${client.address}  ${gen(await balanceOf(client.address))}`)
  console.log(`provider  ${provider.address}  ${gen(await balanceOf(provider.address))}`)

  if (client.address.toLowerCase() === provider.address.toLowerCase()) {
    console.error('\nclient and provider are the same account; the protocol needs two.')
    process.exit(2)
  }

  // Deploy rather than reuse. A fresh instance means the provider starts with no
  // history, so the collateral rate is the 87.5% an unknown agent pays and the
  // figures below are predictable; it also keeps a failed run from leaving
  // half-settled engagements in a deployment the site is pointed at.
  console.log('\ndeploying a fresh ReputationOracle with the bond lock at zero')

  // The minified artifact, not the generated one. `reputation_oracle.py` is
  // 96,285 bytes and bradbury refuses it outright - not for gas, which fails
  // identically at 20M, 40M and 60M, but with `BlockPubdataLimitReached`, a cap
  // on the bytes a block will carry. `reputation_oracle.min.py` is the same
  // contract with 49% of its bytes - docstrings and comments - removed, every
  // line of code copied verbatim and the trees compared with `ast.dump` before
  // it is written. See `minify_contract.py`.
  //
  // Testing the minified file is also the more faithful choice: it is the
  // artifact that reaches the chain, so it is the one whose settlement behaviour
  // is worth asserting.
  const artifact = new URL('../../reputation_oracle.min.py', import.meta.url)
  const code = readFileSync(artifact, 'utf8')
  console.log(`artifact  reputation_oracle.min.py (${code.length.toLocaleString()} bytes)`)
  const deployHash = await client.client.deployContract({ code, args: POLICY as never[] })
  const deployReceipt = await client.client.waitForTransactionReceipt({
    // `deployContract` is typed as returning a plain `0x${string}` while the
    // waiter wants the SDK's branded `Hash`. Same value, narrower type.
    hash: deployHash as Parameters<typeof client.client.waitForTransactionReceipt>[0]['hash'],
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 100,
  })
  const oracle = deployedAddress(deployReceipt)
  if (!oracle) throw new Error(`deploy returned no contract address: ${String(deployHash)}`)
  console.log(`oracle    ${oracle}`)
  if (EXPLORER_URL) console.log(`          ${EXPLORER_URL}/address/${oracle}`)

  const stake = GEN // 1 GEN of declared work value, so collateral is 0.875 GEN
  const overpay = GEN / 20n // 0.05 GEN, deliberately not a round fraction of either

  // --- engagement one: refund on accept, then release without an attestation
  const first = `settlement-release-${Date.now()}`
  console.log(`\n=== ${first} - accept refund, then release ===`)
  await send(client, oracle, 'open_engagement', [
    first,
    addressArg(provider.address, 'open_engagement.provider'),
    SCOPE,
    stake,
  ])

  const quote = await view(oracle, 'collateral_quote', [
    addressArg(provider.address, 'collateral_quote.provider'),
    stake,
  ])
  const required = asBig(field(quote, 'required'), 'collateral_quote.required')
  console.log(
    `  quoted ${gen(required)} at ${String(field(quote, 'rate_bp'))}bp ` +
      `on a score of ${String(field(quote, 'score_bp'))}`,
  )

  await refund(
    'refund: accept_engagement returns collateral sent above the requirement',
    oracle,
    provider,
    required,
    overpay,
    () => send(provider, oracle, 'accept_engagement', [first], required + overpay),
  )

  await send(client, oracle, 'close_engagement', [first])

  // The unattested path: nobody graded it, the lock is zero, so the provider's
  // capital comes back. This is the branch that stops a silent client from
  // holding an agent's working capital hostage.
  await settlement(
    'release_collateral: the provider takes back an ungraded engagement',
    oracle,
    provider,
    required,
    () => send(provider, oracle, 'release_collateral', [first]),
  )

  // --- engagement two: refund on attest, a graded settlement, then the bond
  const second = `settlement-graded-${Date.now()}`
  console.log(`\n=== ${second} - attest refund, graded settlement, bond ===`)
  await send(client, oracle, 'open_engagement', [
    second,
    addressArg(provider.address, 'open_engagement.provider'),
    SCOPE,
    stake,
  ])

  const quote2 = await view(oracle, 'collateral_quote', [
    addressArg(provider.address, 'collateral_quote.provider'),
    stake,
  ])
  const required2 = asBig(field(quote2, 'required'), 'collateral_quote.required')
  await send(provider, oracle, 'accept_engagement', [second], required2)
  await send(client, oracle, 'close_engagement', [second])

  const bond = asBig(
    await view(oracle, 'bond_for_next', [
      addressArg(client.address, 'bond_for_next.attester'),
      addressArg(provider.address, 'bond_for_next.subject'),
    ]),
    'bond_for_next',
  )

  const attested = await refund(
    'refund: attest returns bond sent above the requirement',
    oracle,
    client,
    bond,
    overpay,
    () =>
      send(
        client,
        oracle,
        'attest',
        [
          second,
          'The script was delivered and run against the full 12,000-row file. It ' +
            'de-duplicated on order id keeping the latest timestamp, wrote ' +
            'orders_clean.csv sorted by order id, and finished in about 4 seconds. ' +
            'The README covers how to run it and states that malformed rows are ' +
            'skipped with a count reported at the end.',
          'orders_clean.csv checked against a manual pandas de-duplication of the ' +
            'same input: identical row count (11,842) and identical ordering. Timed ' +
            'over three runs at 3.9s, 4.1s and 4.0s on an M2 laptop. README reviewed ' +
            'and it documents both the invocation and the malformed-row behaviour.',
        ],
        bond + overpay,
      ),
  )

  const attestationId = Number(attested.returned)
  if (!Number.isInteger(attestationId)) {
    throw new Error(`attest returned ${JSON.stringify(attested.returned)}, expected an id`)
  }
  console.log(`    attestation id ${attestationId}`)

  // Which way the grade settled the collateral decides which payout is next.
  // Both are real settlements and both are worth proving; the grade is an LLM's
  // and is not this script's to predict, so it reads the state and follows it.
  const engagement = await view(oracle, 'get_engagement', [second])
  const collateralState = String(field(engagement, 'collateral_state'))
  const held = asBig(field(engagement, 'collateral'), 'get_engagement.collateral')
  console.log(`  graded: collateral_state = ${collateralState}`)

  if (collateralState === 'forfeit') {
    await settlement(
      'claim_collateral: the client takes collateral the grade forfeited',
      oracle,
      client,
      held,
      () => send(client, oracle, 'claim_collateral', [second]),
    )
  } else if (collateralState === 'releasable') {
    await settlement(
      'release_collateral: the provider takes back collateral a clearing grade freed',
      oracle,
      provider,
      held,
      () => send(provider, oracle, 'release_collateral', [second]),
    )
  } else {
    check(false, `collateral_state was ${collateralState}, expected releasable or forfeit`)
  }

  // The bond, last, because it needs the attestation to exist and the lock to
  // have elapsed - which it has, at zero.
  await settlement(
    'reclaim_bond: the attester takes back a bond the grade did not slash',
    oracle,
    client,
    bond,
    () => send(client, oracle, 'reclaim_bond', [attestationId]),
  )

  console.log(`\ncontract holds ${gen(await balanceOf(oracle))} after every settlement`)
  console.log(`oracle ${oracle}`)
}

// Started before `main` rather than inside it, because `role` reads `endpoint`
// as it builds each client and the shim has to be answering by then.
const proxy = await startGasProxy(RPC, {
  // The shim's defaults were measured against studionet, where this contract
  // deploys for about 2,000,000. Bradbury charges far more for the same bytes:
  // the deploy burned 27,684,780 and then reverted against the 30,000,000 cap,
  // which reads as a contract failure and is really a ceiling.
  //
  // 60,000,000 is roughly twice what the deploy actually needs and still well
  // inside bradbury's 100,000,000 block limit - the distinction that matters,
  // because a request at the block limit is unminable and disappears from the
  // mempool without a receipt rather than failing.
  onEstimateFailure: 50_000_000n,
  cap: 60_000_000n,
})
endpoint = proxy.url
console.log(`gas shim  ${proxy.url} -> ${RPC}`)

try {
  await main()
} finally {
  // The shim holds an open listener, so the process would not exit without this.
  await proxy.close()
}

if (failures > 0) {
  console.error(`\nsettlement FAILED: ${failures} of ${checks} checks`)
  process.exit(1)
}
console.log(`\nsettlement ok - ${checks} checks, every payout reached its recipient`)
