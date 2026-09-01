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
// `attest` runs an LLM call inside the consensus round, so it gets its own
// budget rather than borrowing the balance-settling one.
const ATTEST_TIMEOUT_MS = Number(process.env.ATTEST_TIMEOUT_MS ?? 20 * 60 * 1000)
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
/**
 * Complete the payout handshake for a recipient contract.
 *
 * `withdraw` refuses an address that has not done this, so it is a required
 * step rather than a nicety. Neither call moves value: what makes a recipient
 * eligible is that the oracle can view-call `credent_recipient()` on it, which
 * a wallet has no code to answer.
 */
async function proveRecipient(client: Role, oracle: string, recipient: string): Promise<boolean> {
  if ((await view(oracle, 'is_proven', [recipient])) === true) return true

  // Two transactions, and they cannot be one: the oracle records the open
  // handshake in the first and consumes it in the second, so a confirmation
  // cannot arrive unrequested. Neither moves value. What makes the recipient
  // eligible is `credent_recipient()`, which the oracle view-calls on it.
  await send(client, recipient, 'prove', [])
  await send(client, recipient, 'confirm', [])
  const proven = await settleTo(
    async () => ((await view(oracle, 'is_proven', [recipient])) === true ? 1n : 0n),
    (value) => value === 1n,
    ATTEST_TIMEOUT_MS,
  ).catch(() => 0n)
  return proven === 1n
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Run a call that must be rejected, and say whether it was rejected for the
 * stated reason.
 *
 * A guard that is never exercised is a comment. These calls are supposed to
 * fail, so `send` throwing is the pass condition -- and the reason is checked
 * too, because "it failed" is also what a typo in the method name looks like.
 */
async function expectRejection(
  act: () => Promise<Sent>,
  // One or more acceptable reasons. More than one where the contract has two
  // guards on the same call and which fires first depends on the network: a
  // wallet calling `confirm_recipient` is stopped by the origin check on
  // studionet and by the missing probe on bradbury. Both are correct refusals,
  // so pinning either one alone would fail a run that behaved perfectly.
  reason: string | string[],
  // Optional state to fall back on. A studio node that stops answering while a
  // refused transaction settles produces a *receipt wait* timeout, which is
  // indistinguishable from any other thrown error by its text alone -- and
  // reporting it as "rejected for a different reason" fails a run in which the
  // contract refused exactly as it should. Where the caller can name a figure
  // the call would have moved, an unchanged figure settles the question without
  // needing the node to come back.
  unchanged?: () => Promise<bigint>,
): Promise<boolean> {
  const reasons = typeof reason === 'string' ? [reason] : reason
  const before = unchanged ? await unchanged().catch(() => null) : null
  try {
    await act()
    return false
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (reasons.some((r) => text.includes(r))) return true

    if (/Timed out waiting for transaction/i.test(text)) {
      if (before === null) {
        console.log('    the node stopped answering before the receipt settled; nothing to judge on')
        return false
      }
      const after = await unchanged!().catch(() => null)
      if (after !== null && after === before) {
        console.log(`    the node stopped answering, but the state did not move (${gen(before)}); the call was refused`)
        return true
      }
      console.log(`    the node stopped answering and the state moved (${gen(before)} -> ${after === null ? '?' : gen(after)})`)
      return false
    }

    // Bradbury does not carry the contract's reason string in the receipt at
    // all -- the whole of what it reports is
    // `txExecutionResultName: "FINISHED_WITH_ERROR"`, while studio returns the
    // `[EXPECTED] …` message. So the reason can only be asserted where the
    // network provides one. Demanding it everywhere failed three checks on a
    // run where the contract refused exactly as it should, which is a test
    // reporting a platform difference as a contract defect.
    if (/FINISHED_WITH_ERROR|rejected by the contract$/.test(text)) {
      console.log(`    refused; this network reports no reason string (expected "${reasons.join('" or "')}")`)
      return true
    }

    console.log(`    rejected, but for a different reason: ${text.slice(0, 120)}`)
    return false
  }
}

async function settleTo(
  read: (() => Promise<bigint>) | string,
  settled: (value: bigint) => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<bigint> {
  // Takes a reader rather than only an address, because the two things worth
  // waiting on settle at different places: an entitlement lands in contract
  // storage and a payout lands in a balance. Polling a balance for a change
  // that was only ever going to appear in storage is how a working settlement
  // gets reported as a timeout.
  const reader = typeof read === 'string' ? () => balanceOf(read) : read
  const started = Date.now()
  const deadline = started + timeoutMs
  let current = await reader()
  let announced = 0

  while (!settled(current) && Date.now() < deadline) {
    await sleep(5_000)
    const waited = Math.floor((Date.now() - started) / 1000)
    if (waited - announced >= 30) {
      announced = waited
      console.log(`         ...waiting (${waited}s, ${gen(current)} so far)`)
    }
    current = await reader()
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
/**
 * Submit a transaction, waiting out the node's own rate limiter.
 *
 * Bradbury answers `-32005 transaction gas rate limit exceeded: node is at
 * capacity, retry in ~1190ms` when a run submits faster than it will accept.
 * That is the node saying "later", not the contract saying "no", and viem
 * surfaces it as a thrown `LimitExceededRpcError` that killed a whole
 * settlement run mid-way. The error even carries the delay to wait, so honour
 * it rather than guessing, and fall back to exponential backoff when it does
 * not.
 *
 * Only this one condition is retried. Anything else -- a contract rejection
 * above all -- is rethrown immediately, because silently retrying a refusal
 * would turn a working guard into a hang.
 */
async function submitWithBackoff<T>(submit: () => Promise<T>, attempts = 25): Promise<T> {
  let wait = 2_000
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await submit()
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      const rateLimited =
        text.includes('-32005') ||
        text.includes('node is at capacity') ||
        text.includes('gas rate limit exceeded')
      if (!rateLimited || attempt >= attempts) throw err
      const advised = Number(/retryAfterMs"?\s*:\s*(\d+)/.exec(text)?.[1] ?? 0)
      const delay = Math.max(advised + 250, wait)
      console.log(`         node at capacity; waiting ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`)
      await sleep(delay)
      // Many modest retries rather than a few long ones. Bradbury advises
      // delays in the hundreds of milliseconds while staying busy for minutes,
      // so an aggressively doubling wait spends the whole budget sleeping and
      // gets few actual attempts. Capping at 15s gives roughly five minutes of
      // persistent retrying across twenty-five tries instead of three.
      wait = Math.min(wait * 2, 15_000)
    }
  }
}

async function send(
  who: Role,
  address: string,
  functionName: string,
  args: unknown[],
  value = 0n,
): Promise<Sent> {
  const hash = await submitWithBackoff(() =>
    who.client.writeContract({
      address: address as `0x${string}`,
      functionName,
      args: args as never[],
      value,
    }),
  )
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
  // Only the name and the address are used, so this is deliberately narrower
  // than `Role`: the recipient of a settlement may be a contract, which has no
  // signing account behind it.
  recipient: { name: string; address: string },
  amount: bigint,
  act: () => Promise<Sent>,
): Promise<void> {
  console.log(`\n  ${label}`)
  console.log(`    owed ${gen(amount)} to ${recipient.name} ${recipient.address}`)

  // What is asserted here is the **entitlement**, not the recipient's balance.
  //
  // Settlement credits rather than pays, because `emit_transfer` does not credit
  // an externally-owned account: to a wallet the value leaves the contract and
  // arrives nowhere. Pushing at settlement time therefore recorded a settlement
  // and moved no money, which is exactly what the review caught. Crediting is
  // pure storage - it cannot fail, cannot be dropped by a consensus round, and
  // is readable afterwards - and moving the value is a separate call the
  // recipient makes when it is able to receive.
  //
  // So this proves the accounting, and `withdrawal()` below proves the money
  // actually leaves. Both halves are needed; neither is sufficient alone.
  const contractBefore = await balanceOf(oracle)
  const owedBefore = asBig(await view(oracle, 'owed_to', [recipient.address]), 'owed_to')

  const sent = await act()
  console.log(`    tx   ${sent.hash}`)
  if (EXPLORER_URL) console.log(`         ${EXPLORER_URL}/tx/${sent.hash}`)

  const owedAfter = await settleTo(
    async () => asBig(await view(oracle, 'owed_to', [recipient.address]), 'owed_to'),
    (value) => value >= owedBefore + amount,
  )
  const contractAfter = await balanceOf(oracle)
  const owedDelta = owedAfter - owedBefore

  console.log(`    owed_to   ${gen(owedBefore)} -> ${gen(owedAfter)}  (${delta(owedDelta)})`)
  console.log(`    contract  ${gen(contractBefore)} -> ${gen(contractAfter)}`)

  check(owedDelta === amount, `the entitlement rose by exactly ${gen(amount)}`)
  // The contract must still be holding it. Settlement moves nothing on its own,
  // and a contract whose balance fell here would mean value left by some path
  // this script does not know about.
  check(
    contractAfter === contractBefore,
    `the contract still holds the funds (${gen(contractAfter)})`,
  )
}

/**
 * Prove the money actually leaves.
 *
 * The entitlement assertions above are accounting. This is the part the review
 * asked for: a settlement that ends with a balance moving out of the contract
 * and into the recipient.
 *
 * The recipient is a **contract**, and that is not incidental. `emit_transfer`
 * credits a contract recipient and does not credit a wallet - measured both
 * ways, in both `on` modes - so on this platform a party that expects to be paid
 * has to be able to receive, and receiving means being a contract. `Claimant` is
 * the smallest one that works.
 */
async function withdrawal(
  label: string,
  oracle: string,
  claimant: string,
  expected: bigint,
  act: () => Promise<Sent>,
  // Whose entitlement is being spent. The same address as the recipient when a
  // contract withdraws its own credit, and a *wallet* when that wallet uses
  // `assign_to` to hand its credit to a contract, which then withdraws - the
  // exists because a wallet cannot receive at all, so its entitlement would
  // otherwise be recorded correctly and be immovable.
  owner: string = claimant,
  // How the recipient resolves its own withdrawal afterwards. `withdraw` parks
  // the entitlement in `in_flight` rather than dropping it, so the payout is
  // not finished until `reclaim` has judged it against the recipient's balance
  // and closed it. Asserting that here means the review's third item is
  // exercised on every payout the suite makes, not only in the runs written to
  // demonstrate it.
  settle?: () => Promise<Sent>,
): Promise<void> {
  console.log(`\n  ${label}`)

  // Wait for the entitlement to stop moving before snapshotting it. A credit
  // emitted by an earlier step can land *after* this function starts, and then
  // `withdraw` pays what is owed at execution time while the assertions below
  // compare against a figure read before it arrived. That produced a false
  // failure on bradbury: the contract paid 0.934999 GEN, correctly, against a
  // snapshot of 0.924999 GEN taken 0.01 GEN too early.
  let owedBefore = asBig(await view(oracle, 'owed_to', [owner]), 'owed_to')
  for (let settledReads = 0; settledReads < 3; ) {
    await sleep(5_000)
    const again = asBig(await view(oracle, 'owed_to', [owner]), 'owed_to')
    settledReads = again === owedBefore ? settledReads + 1 : 0
    owedBefore = again
  }
  const contractBefore = await balanceOf(oracle)
  const claimantBefore = await balanceOf(claimant)
  console.log(`    owed_to(${owner === claimant ? 'claimant' : 'owner'}) ${gen(owedBefore)}`)

  const sent = await act()
  console.log(`    tx   ${sent.hash}`)
  if (EXPLORER_URL) console.log(`         ${EXPLORER_URL}/tx/${sent.hash}`)

  // Wait for the *whole* payout, not for any movement at all. `value >
  // claimantBefore` looked equivalent and was not: on bradbury a 0.01 GEN bond
  // came back to this same contract from an unrelated attestation that never
  // recorded, the poll saw the balance rise, stopped 150s before the withdrawal
  // actually landed, and the run reported that the contract had underpaid and
  // left the entitlement standing. Both claims were false -- re-driving the
  // same withdraw against the same state settled in full -- and a false payout
  // failure on this path is the most expensive kind of wrong this suite can be.
  //
  // The entitlement is checked alongside the balance because neither alone is
  // sufficient: `withdraw` zeroes the entitlement *before* it emits, so storage
  // settles first, and any inbound value moves the balance whether this payout
  // caused it or not.
  //
  // The two polls are bounded differently on purpose. Zeroing the entitlement
  // is pure contract storage with no epoch involved, so it gets the attest
  // budget: if it has not happened in twenty minutes, `withdraw` did not run
  // and there is nothing to wait for. The balance is the emitted transfer,
  // which genuinely can straddle an epoch boundary, so it keeps the long
  // settle budget -- but only once storage says the payout was actually made.
  // Waiting 26 hours for a transfer that was never emitted is how a fast
  // failure turns into an abandoned run.
  // `owedBefore`, not `expected`: what is still on the books is what this
  // withdrawal moves. A recipient that proved during this run has already been
  // paid the probe, so waiting for the full credited amount to arrive *now*
  // waits for a wei that arrived several transactions ago and never comes
  // again. That was a real hang, not a hypothetical one.
  const wanted = claimantBefore + owedBefore
  const owedSettled = await settleTo(
    async () => asBig(await view(oracle, 'owed_to', [owner]), 'owed_to'),
    (value) => value === 0n,
    ATTEST_TIMEOUT_MS,
  )
  const claimantAfter =
    owedSettled === 0n
      ? await settleTo(() => balanceOf(claimant), (value) => value >= wanted)
      : await balanceOf(claimant)
  const contractAfter = await balanceOf(oracle)
  const owedAfter = asBig(await view(oracle, 'owed_to', [owner]), 'owed_to')

  console.log(`    contract  ${gen(contractBefore)} -> ${gen(contractAfter)}  (${delta(contractAfter - contractBefore)})`)
  console.log(`    claimant  ${gen(claimantBefore)} -> ${gen(claimantAfter)}  (${delta(claimantAfter - claimantBefore)})`)
  console.log(`    owed_to   ${gen(owedBefore)} -> ${gen(owedAfter)}`)

  // The handshake moves no value, so what is on the books is the whole of what
  // was credited. Anything else is an accounting error, not a fee.
  check(owedBefore === expected, `the entitlement on the books is the whole ${gen(expected)}`)
  const arrived = check(
    claimantAfter - claimantBefore >= owedBefore,
    `the claimant received the whole entitlement (${delta(claimantAfter - claimantBefore)})`,
  )
  // Race-free, and a stronger claim than comparing against the snapshot: every
  // wei that left this contract arrived at the recipient, whatever else landed
  // in the meantime. The snapshot is still asserted, as a lower bound, by the
  // arrival check above.
  check(
    contractBefore - contractAfter === claimantAfter - claimantBefore,
    `every wei that left the contract arrived at the recipient (${gen(contractBefore - contractAfter)})`,
  )
  check(owedAfter === 0n, 'the entitlement was zeroed')

  if (settle) {
    const parked = asBig(await view(oracle, 'in_flight_to', [claimant]), 'in_flight_to')
    check(parked === owedBefore, `and parked in flight (${gen(parked)}) rather than discarded`)
    const settled = await settle()
    console.log(`    reclaim  ${settled.hash}`)
    const resolved = await settleTo(
      async () => asBig(await view(oracle, 'in_flight_to', [claimant]), 'in_flight_to'),
      (value) => value === 0n,
      ATTEST_TIMEOUT_MS,
    )
    check(resolved === 0n, 'reclaim resolved the withdrawal')
    check(
      asBig(await view(oracle, 'owed_to', [claimant]), 'owed_to') === 0n,
      'and credited nothing back, because the value arrived',
    )
  }
  if (!arrived) {
    console.error(
      `    -> the entitlement was recorded and the money did not move.\n` +
        `       Check that the recipient is a contract: emit_transfer does not\n` +
        `       credit an externally-owned account.`,
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
  // Narrower than `Role` for the same reason `settlement` is: the party being
  // refunded may be a contract, which has no signing account behind it.
  sender: { name: string; address: string },
  kept: bigint,
  excess: bigint,
  act: () => Promise<Sent>,
): Promise<Sent> {
  console.log(`\n  ${label}`)
  console.log(
    `    ${sender.name} sends ${gen(kept + excess)}, of which ${gen(excess)} must come back`,
  )

  // An overpayment is **credited back, not pushed back**, for the same reason
  // every other settlement is: pushing at a wallet moves nothing. So the
  // contract legitimately ends up holding the whole `kept + excess`, and what
  // proves the refund happened is the entitlement, not a fallen balance. An
  // earlier revision of this function asserted the balance and reported a
  // working refund as a failure.
  const contractBefore = await balanceOf(oracle)
  const owedBefore = asBig(await view(oracle, 'owed_to', [sender.address]), 'owed_to')

  const sent = await act()
  console.log(`    tx   ${sent.hash}`)

  const owedAfter = await settleTo(
    async () => asBig(await view(oracle, 'owed_to', [sender.address]), 'owed_to'),
    (value) => value >= owedBefore + excess,
  )
  const contractAfter = await balanceOf(oracle)

  console.log(`    contract  ${gen(contractBefore)} -> ${gen(contractAfter)}  (${delta(contractAfter - contractBefore)})`)
  console.log(`    owed_to   ${gen(owedBefore)} -> ${gen(owedAfter)}  (${delta(owedAfter - owedBefore)})`)

  check(
    owedAfter - owedBefore === excess,
    `the overpayment of ${gen(excess)} came back as an entitlement`,
  )
  check(
    contractAfter - contractBefore === kept + excess,
    `the contract holds the ${gen(kept)} requirement plus the credited ${gen(excess)}`,
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
 * fortnight, `withdrawal_settle_seconds` is zero so `reclaim` can resolve a
 * payout in the same run instead of fifteen minutes later, and `min_bond` is
 * small so a full run costs little. Everything else is the deployed policy, so
 * the collateral arithmetic under test is the real one.
 *
 * The settle window is the one of these that is a safety parameter rather than
 * a convenience: at zero, `reclaim` will judge a withdrawal before the transfer
 * has had time to land. That is fine here, where the suite waits for the payout
 * to arrive before it calls `reclaim` at all, and it is why the production
 * deployments run 900.
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
  0n, // bond_lock_seconds - one of two changes that make this runnable in one pass
  0n, // withdrawal_settle_seconds - the other; production waits 900s
  15000n, // collateral_ceiling_bp
  2500n, // collateral_floor_bp
  2500n, // collateral_forfeit_bp
]

/**
 * The same policy with the forfeit threshold at 100%.
 *
 * `claim_collateral` is only reachable when a grade leaves the collateral
 * `forfeit`, which happens when the graded `fulfilled` falls below
 * `collateral_forfeit_bp`. On the real 25% threshold that needs an LLM to judge
 * the work a near-total failure, so the branch fired or did not depending on the
 * grade - and on the run that prompted this change it did not, leaving `claim`
 * the one payout in the review's list that the suite never actually exercised.
 *
 * Raising the threshold rather than writing a deliberately terrible attestation
 * keeps the grade real: the work is still judged by the same nondet block, and
 * only the policy line that decides what counts as failure moves. Any grade
 * short of perfect forfeits, so the path is reachable every run.
 */
const FORFEIT_POLICY = POLICY.map((value, index) =>
  index === POLICY.length - 1 ? 10000n : value,
)

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

/**
 * Deploy one ReputationOracle and return its address.
 *
 * A function rather than a block because the run needs two: the main instance
 * on the real policy, and a second one whose forfeit threshold is raised so the
 * `claim_collateral` path is reachable without waiting for an LLM to grade a
 * piece of work badly. See `FORFEIT_POLICY`.
 *
 * The minified artifact, not the generated one. `reputation_oracle.py` is over
 * 100,000 bytes and bradbury refuses it outright - not for gas, which fails
 * identically at 20M, 40M and 60M, but with `BlockPubdataLimitReached`, a cap on
 * the bytes a block will carry. `reputation_oracle.min.py` is the same contract
 * with its docstrings and comments removed, every line of code copied verbatim
 * and the trees compared with `ast.dump` before it is written. Testing it is
 * also the more faithful choice: it is the artifact that reaches the chain.
 */
async function deployOracle(client: Role, policy: bigint[]): Promise<string> {
  const artifact = new URL('../../reputation_oracle.min.py', import.meta.url)
  const code = readFileSync(artifact, 'utf8')
  console.log(`artifact  reputation_oracle.min.py (${code.length.toLocaleString()} bytes)`)
  const deployHash = await submitWithBackoff(() => client.client.deployContract({ code, args: policy as never[] }))
  const deployReceipt = await client.client.waitForTransactionReceipt({
    // `deployContract` is typed as returning a plain `0x${string}` while the
    // waiter wants the SDK's branded `Hash`. Same value, narrower type.
    hash: deployHash as Parameters<typeof client.client.waitForTransactionReceipt>[0]['hash'],
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 100,
  })
  const address = deployedAddress(deployReceipt)
  if (!address) throw new Error(`deploy returned no contract address: ${String(deployHash)}`)
  return address
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
  const oracle = await deployOracle(client, POLICY)
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

  // --- engagement three: a contract provider, paid for real ----------------
  //
  // Everything above proves the accounting. This proves the money leaves.
  //
  // The provider here is a `Claimant` contract rather than a wallet, and that is
  // the whole point: `emit_transfer` credits a contract recipient and does not
  // credit an externally-owned account, so a party that expects to be paid on
  // this platform has to be able to receive, and receiving means being a
  // contract. The claimant accepts the engagement (forwarding its own
  // collateral, so the oracle sees it as the provider), the collateral is
  // released to its entitlement, and then it withdraws and the balance moves.
  const third = `settlement-withdraw-${Date.now()}`
  console.log(`\n=== ${third} - a contract provider withdraws ===`)

  const claimantSource = readFileSync(new URL('../scripts/claimant.py', import.meta.url), 'utf8')
  // `../scripts/`, not `./`: esbuild bundles this into `web/.tmp/`, so
  // `import.meta.url` resolves relative to that directory and not to the
  // source file. The oracle artifact above climbs out the same way.
  const claimantHash = await submitWithBackoff(() => client.client.deployContract({
    code: claimantSource,
    args: [oracle] as never[],
  }))
  const claimantReceipt = await client.client.waitForTransactionReceipt({
    hash: claimantHash as Parameters<typeof client.client.waitForTransactionReceipt>[0]['hash'],
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 100,
  })
  const claimant = deployedAddress(claimantReceipt)
  if (!claimant) throw new Error('claimant deploy returned no address')
  console.log(`  claimant  ${claimant}`)
  if (EXPLORER_URL) console.log(`            ${EXPLORER_URL}/address/${claimant}`)

  await send(client, oracle, 'open_engagement', [
    third,
    addressArg(claimant, 'open_engagement.provider'),
    SCOPE,
    stake,
  ])

  const quote3 = await view(oracle, 'collateral_quote', [
    addressArg(claimant, 'collateral_quote.provider'),
    stake,
  ])
  const required3 = asBig(field(quote3, 'required'), 'collateral_quote.required')
  console.log(`  quoted ${gen(required3)} for the contract provider`)

  // The rejection named three payout types specifically -- release, refund and
  // bond reclaim -- as leaving funds in the contract. So the claimant earns all
  // three, and the withdrawal at the end has to carry the sum of them.

  // 1. Refund. The claimant overpays its collateral; the excess is credited.
  await refund(
    'refund: the contract provider overpays and is credited the excess',
    oracle,
    { name: 'claimant', address: claimant },
    required3,
    overpay,
    () => send(client, claimant, 'accept', [third], required3 + overpay),
  )

  await send(client, oracle, 'close_engagement', [third])

  // 2. Bond reclaim. The claimant attests about the client -- the oracle allows
  // either party to grade the other -- posting a bond from its own balance, and
  // then reclaims it. The lock is zero under this policy.
  const bond3 = asBig(
    await view(oracle, 'bond_for_next', [
      addressArg(claimant, 'bond_for_next.attester'),
      addressArg(client.address, 'bond_for_next.subject'),
    ]),
    'bond_for_next',
  )
  const countBefore3 = asBig(
    await view(oracle, 'attestation_count', []),
    'attestation_count',
  )
  const attested3 = await send(
    client,
    claimant,
    'attest',
    [
      third,
      'The client fixed the scope before work started and did not change it. ' +
        'The brief specified orders.csv at about 12,000 rows, de-duplication on ' +
        'order id keeping the latest timestamp, and orders_clean.csv sorted by ' +
        'order id. Payment terms were settled on acceptance with no renegotiation.',
      'The scope string was committed at open_engagement and its digest is ' +
        'on-chain, so any later edit would be visible as a different digest; it ' +
        'is unchanged. close_engagement was called once, by the client, with no ' +
        'amendment between open and close. The collateral of 0.875 GEN was ' +
        'released in full rather than forfeited, which is the on-chain record of ' +
        'the client raising no dispute.',
    ],
    bond3,
  )
  void attested3

  // Wait for the new attestation to land before naming its id.
  //
  // Reading `attestation_count` straight after the write returns the count from
  // *before* it, so `count - 1` names the previous attestation -- engagement
  // two's, whose attester is the client wallet rather than this contract. The
  // reclaim then targets a bond the caller does not own and is refused. Polling
  // for the count to actually rise is the difference between an id and a guess.
  const countAfter = await settleTo(
    async () => asBig(await view(oracle, 'attestation_count', []), 'attestation_count'),
    (value) => value > countBefore3,
    ATTEST_TIMEOUT_MS,
  )
  const attestRecorded = countAfter > countBefore3
  const attestationId3 = attestRecorded ? Number(countAfter) - 1 : -1

  if (!attestRecorded) {
    // This is a **timeout, not a verdict**. `attest` runs an LLM call inside the
    // consensus round, and a contract-emitted one adds a hop on top; on
    // testnet-bradbury it has taken over fifteen minutes and settled fine at
    // twenty. An earlier revision of this comment concluded from a single
    // fifteen-minute timeout that a contract-emitted attest *cannot* settle
    // there. It can. That is the same error -- one failed measurement
    // generalized into a platform limitation -- that this whole change exists
    // to correct, so it is recorded here rather than quietly deleted.
    //
    // Raise ATTEST_TIMEOUT_MS before concluding anything from this branch. It
    // is a bond *creation* path, so the refund and release below are unaffected
    // and still prove what this script is for; the bond is simply excluded from
    // the total, which is better than reporting a smaller number as if it were
    // the whole story.
    console.log(
      `    the attestation had not recorded within ` +
        `${Math.round(ATTEST_TIMEOUT_MS / 1000)}s, so bond reclaim is excluded\n` +
        `    from the withdrawal below. This is a timeout, not a failure: raise\n` +
        `    ATTEST_TIMEOUT_MS and re-run before drawing any conclusion from it.`,
    )
  } else {
    console.log(`    attestation id ${attestationId3} (count ${countBefore3} -> ${countAfter})`)
  }

  // Follow the grade rather than assume it. The bond is an LLM's to slash, and
  // a slashed bond is correctly unreclaimable -- that is what bonding is for.
  // An earlier revision asserted the reclaim unconditionally and failed the
  // suite on the contract behaving exactly as designed.
  let reclaimed3 = 0n
  const graded3 = attestRecorded ? await view(oracle, 'get_attestation', [attestationId3]) : null
  const bondState3 = graded3 ? String(field(graded3, 'bond_state')) : 'not-recorded'
  if (graded3) {
    console.log(
      `    graded ${String(field(graded3, 'verdict'))}, ` +
        `substantiated ${String(field(graded3, 'substantiated'))}, ` +
        `bond_state ${bondState3}`,
    )
  }

  if (!attestRecorded) {
    // Nothing to reclaim; already explained above.
  } else if (bondState3 === 'slashed') {
    console.log(
      `    the grade slashed this bond, so it is not reclaimable and is not\n` +
        `    part of the withdrawal below. That is the bond doing its job.`,
    )
  } else {
    await settlement(
      'reclaim_bond: the contract attester is credited its bond',
      oracle,
      { name: 'claimant', address: claimant },
      bond3,
      () => send(client, claimant, 'reclaim', [attestationId3]),
    )
    reclaimed3 = bond3
  }

  // 3. Release. The collateral itself comes back.
  await settlement(
    'release_collateral: the contract provider is credited',
    oracle,
    { name: 'claimant', address: claimant },
    required3,
    // Sent through the claimant: the oracle checks the caller against the
    // engagement's provider, and the provider is the contract.
    () => send(client, claimant, 'release', [third]),
  )

  // All three, withdrawn in one call. This is the number the review asked for:
  // funds from a release, a refund and a bond reclaim, leaving the contract.
  const total3 = required3 + overpay + reclaimed3
  const covered = reclaimed3 > 0n ? 'release, refund and bond reclaim' : 'release and refund'
  console.log(`\n  owed from ${covered}: ${gen(total3)}`)
  check(
    await proveRecipient(client, oracle, claimant),
    `claimant proved it can receive`,
  )
  await withdrawal(
    `withdraw: ${covered} all leave the contract`,
    oracle,
    claimant,
    total3,
    () => send(client, claimant, 'claim', []),
    claimant,
    () => send(client, claimant, 'settle_withdrawal', []),
  )

  // --- engagement four: a forfeited grade, claimed by a wallet -------------
  //
  // Two things neither of the three above proves.
  //
  // `claim_collateral` is the fourth payout the review named, and it was the one
  // the suite could not promise to reach: it is only live when a grade leaves
  // the collateral `forfeit`, and on the real 25% threshold that is an LLM's
  // judgement, not this script's. A run where the grade cleared the work - which
  // is what happened - passed every check without ever touching `claim`. This
  // engagement runs on a second oracle whose forfeit threshold is 100%, so the
  // grade is still real and the branch is reachable regardless of how it lands.
  //
  // And the claimant here is the **client's own wallet**, which is the harder
  // half. Settlement credits whoever is owed, and four of the five parties this
  // contract credits are ordinarily wallets. `withdraw` pays
  // `gl.message.sender_address`, so a wallet calling it achieves nothing:
  // `emit_transfer` does not credit an externally-owned account. Without
  // `assign_to` a wallet's entitlement is accounted for, visible through
  // `owed_to`, and permanently immobile - the same settlement defect the review
  // caught, moved one step down the pipe.
  const fourth = `settlement-forfeit-${Date.now()}`
  console.log(`\n=== ${fourth} - a forfeited grade, claimed by a wallet ===`)
  console.log('\ndeploying a second oracle with the forfeit threshold at 100%')
  const strict = await deployOracle(client, FORFEIT_POLICY)
  console.log(`  oracle    ${strict}`)

  await send(client, strict, 'open_engagement', [
    fourth,
    addressArg(provider.address, 'open_engagement.provider'),
    SCOPE,
    stake,
  ])
  const quote4 = await view(strict, 'collateral_quote', [
    addressArg(provider.address, 'collateral_quote.provider'),
    stake,
  ])
  const required4 = asBig(field(quote4, 'required'), 'collateral_quote.required')
  await send(provider, strict, 'accept_engagement', [fourth], required4)
  await send(client, strict, 'close_engagement', [fourth])

  const bond4 = asBig(
    await view(strict, 'bond_for_next', [
      addressArg(client.address, 'bond_for_next.attester'),
      addressArg(provider.address, 'bond_for_next.subject'),
    ]),
    'bond_for_next',
  )
  await send(
    client,
    strict,
    'attest',
    [
      fourth,
      'The script runs and writes orders_clean.csv, but it de-duplicates on the ' +
        'wrong column and keeps the earliest row rather than the latest, so the ' +
        'output does not match the scope. No README was delivered.',
      'Ran it against the same 12,000-row input and diffed the output against a ' +
        'manual pandas de-duplication on order id: 412 rows differ, and spot ' +
        'checks show the retained row is the oldest timestamp rather than the ' +
        'newest. The repository contains no README.',
    ],
    bond4,
  )

  // Polled, not read once. `send` returns when the attestation is ACCEPTED, and
  // on bradbury the collateral settlement it performs becomes readable a beat
  // later -- so an immediate read returns `held`, the pre-grade state, and looks
  // exactly like a grade that never happened. It is the same read-after-write
  // lag the entitlement checks already poll around; this path was the one that
  // did not, and it reported a working contract as broken.
  await settleTo(
    async () => {
      const seen = String(field(await view(strict, 'get_engagement', [fourth]), 'collateral_state'))
      return seen === 'held' ? 0n : 1n
    },
    (graded) => graded === 1n,
    // The attest timeout, not settleTo's default. What this waits for *is* an
    // attestation landing, and the default is 26 hours -- so on a run where a
    // contract-emitted attest never arrived, which bradbury does, the suite sat
    // on this poll for ninety minutes and would have sat there overnight rather
    // than reporting a clean timeout. Observed doing exactly that.
    ATTEST_TIMEOUT_MS,
  ).catch(() => 0n)

  const engagement4 = await view(strict, 'get_engagement', [fourth])
  const state4 = String(field(engagement4, 'collateral_state'))
  const held4 = asBig(field(engagement4, 'collateral'), 'get_engagement.collateral')
  console.log(`  graded: collateral_state = ${state4}`)
  // Not a branch. On a 100% threshold anything short of a perfect grade
  // forfeits, so `releasable` here means the grade came back perfect for work
  // the attestation describes as wrong - worth failing over rather than routing
  // around.
  check(state4 === 'forfeit', `the grade forfeited the collateral (state=${state4})`)

  if (state4 === 'forfeit') {
    await settlement(
      'claim_collateral: the client takes collateral the grade forfeited',
      strict,
      { name: 'client wallet', address: client.address },
      held4,
      () => send(client, strict, 'claim_collateral', [fourth]),
    )

    // A second Claimant, pointed at the strict oracle, purely as somewhere the
    // wallet can send its credit. It is not a party to the engagement.
    const sinkHash = await submitWithBackoff(() => client.client.deployContract({
      code: claimantSource,
      args: [strict] as never[],
    }))
    const sinkReceipt = await client.client.waitForTransactionReceipt({
      hash: sinkHash as Parameters<typeof client.client.waitForTransactionReceipt>[0]['hash'],
      status: TransactionStatus.ACCEPTED,
      interval: 5_000,
      retries: 100,
    })
    const sink = deployedAddress(sinkReceipt)
    if (!sink) throw new Error('sink claimant deploy returned no address')
    console.log(`  recipient ${sink}`)

    // Two steps, and the split is the fix. The wallet *assigns* its
    // entitlement, which moves no value and so cannot fail; the contract then
    // withdraws for itself, which is the only call that emits. The earlier
    // design collapsed these into one method that pushed value at an address
    // the contract could not verify -- and an undeliverable transfer is not
    // refunded, so that method could destroy the entitlement it was moving.
    await send(client, strict, 'assign_to', [addressArg(sink, 'assign_to.recipient')])
    const assigned = asBig(await view(strict, 'owed_to', [sink]), 'owed_to')
    check(assigned === held4, `the entitlement moved to the contract (${gen(assigned)})`)
    check(
      asBig(await view(strict, 'owed_to', [client.address]), 'owed_to') === 0n,
      "the wallet's entitlement is spent, not duplicated",
    )

    // Against `strict`, not `oracle`: the sink is a recipient of the
    // strict-policy oracle, and proving it to the wrong one would leave the
    // withdrawal below refused for a reason that looks like a contract bug.
    check(
      await proveRecipient(client, strict, sink),
      `sink proved it can receive`,
    )
    await withdrawal(
      'withdraw: the contract collects the collateral the wallet assigned it',
      strict,
      sink,
      held4,
      () => send(client, sink, 'claim', []),
      sink,
      () => send(client, sink, 'settle_withdrawal', []),
    )
  }

  // --- the wallet's own credit on the main oracle --------------------------
  //
  // The review named release, refund and bond reclaim as the three that stay
  // stuck in the contract. Release leaves in engagement three, taken out by the
  // contract provider. The other two were credited to the **client's wallet**
  // in engagement two - the attest overpayment and the bond the grade did not
  // slash - and nothing took them out, because until `assign_to` existed
  // nothing could.
  //
  // This is deliberately not folded into engagement three's withdrawal. That
  // one carries a bond reclaim only when the grade leaves the claimant's bond
  // releasable, and on a run where it is slashed - which happens, correctly,
  // and is the bond doing its job - the withdrawal covers release and refund
  // alone. Proving bond-reclaim money leaves has to come from a bond that was
  // actually reclaimed, and that is this one.
  const walletOwed = asBig(await view(oracle, 'owed_to', [client.address]), 'owed_to')
  console.log(`\n=== the client wallet's own credit ===`)
  console.log(`  owed_to(client wallet) ${gen(walletOwed)}`)
  check(
    walletOwed === overpay + bond,
    `the wallet holds its refund plus its reclaimed bond (${gen(overpay + bond)})`,
  )

  if (walletOwed > 0n) {
    const walletSinkHash = await submitWithBackoff(() => client.client.deployContract({
      code: claimantSource,
      args: [oracle] as never[],
    }))
    const walletSinkReceipt = await client.client.waitForTransactionReceipt({
      hash: walletSinkHash as Parameters<typeof client.client.waitForTransactionReceipt>[0]['hash'],
      status: TransactionStatus.ACCEPTED,
      interval: 5_000,
      retries: 100,
    })
    const walletSink = deployedAddress(walletSinkReceipt)
    if (!walletSink) throw new Error('wallet sink deploy returned no address')
    console.log(`  recipient ${walletSink}`)

    await send(client, oracle, 'assign_to', [addressArg(walletSink, 'assign_to.recipient')])
    check(
      await proveRecipient(client, oracle, walletSink),
      `walletSink proved it can receive`,
    )
    await withdrawal(
      'assign_to + withdraw: the wallet takes out its refund and reclaimed bond',
      oracle,
      walletSink,
      walletOwed,
      () => send(client, walletSink, 'claim', []),
      walletSink,
      () => send(client, walletSink, 'settle_withdrawal', []),
    )
  }

  // --- the safety property, exercised rather than described ----------------
  //
  // `withdraw` emits value and cannot observe whether it arrived, so the
  // contract establishes *before* it emits that the caller is a Credent
  // recipient contract: it calls `credent_recipient()` by view on the caller's
  // own address. A wallet has no code to answer with and the failure is not
  // catchable, so the transaction ends there. The refusal carries no reason
  // string anywhere, because it is not a classified rejection -- it is the
  // transaction not completing, which is why the checks below read the state
  // afterwards rather than only the error.
  //
  // What is exercised here is that a wallet cannot reach any part of the payout
  // path: not `withdraw`, not `confirm_recipient`, and -- unlike every earlier
  // build -- not `prove_recipient` either.
  console.log(`\n=== the payout guard ===`)

  const walletProven = await view(oracle, 'is_proven', [client.address])
  check(walletProven === false, 'an ordinary wallet is not a proven recipient')

  // Either refusal is correct and which one fires is a property of the network,
  // not of the contract: a wallet trips the origin check first where
  // `origin_address` is the initiator, and the missing proof where it is not.
  const refused = await expectRejection(
    () => send(client, oracle, 'withdraw', []),
    ['recipient_has_not_proven', 'caller_is_the_transaction_origin'],
    async () => asBig(await view(oracle, 'owed_to', [client.address]), 'owed_to'),
  )
  check(refused, 'withdraw from an unproven wallet is refused, not attempted')

  const badAddress = await expectRejection(
    () => send(client, oracle, 'assign_to', [addressArg(ZERO_ADDRESS, 'assign_to.recipient')]),
    'zero_address',
    async () => asBig(await view(oracle, 'owed_to', [ZERO_ADDRESS]), 'owed_to'),
  )
  check(badAddress, 'assigning to the zero address is refused')

  const claimantProven = await view(oracle, 'is_proven', [claimant])
  check(claimantProven === true, 'the claimant contract proved it can receive')

  // A confirmation that answers nothing must be refused. Without this the
  // handshake is decorative: any address could call `confirm_recipient` once
  // and mark itself proven, which is exactly what an earlier build allowed --
  // measured against a throwaway oracle, a wallet went from unproven to proven
  // in a single direct call.
  const provenFlag = async (): Promise<bigint> =>
    ((await view(oracle, 'is_proven', [client.address])) === true ? 1n : 0n)
  const unrequested = await expectRejection(
    () => send(client, oracle, 'confirm_recipient', []),
    ['no_probe_outstanding', 'caller_is_the_transaction_origin'],
    provenFlag,
  )
  check(unrequested, 'a confirmation with no outstanding probe is refused')
  const stillUnproven = await view(oracle, 'is_proven', [client.address])
  check(stillUnproven === false, 'the refused confirmation left the wallet unproven')

  // The case the second review named: "a wallet can mark itself proven, then
  // withdraw clears its owed balance before an undeliverable transfer". The
  // first half is what made the rest possible, and it is what this asserts is
  // now impossible -- on both networks, not only on the one where
  // `origin_address` happens to be the initiator.
  //
  // The wallet is not merely refused at `confirm_recipient`; it is refused at
  // `prove_recipient`, so no probe is ever raised for it and there is nothing
  // to answer. Asserted on the state rather than on an error string, because
  // this refusal is a transaction that does not complete and neither network
  // reports a reason for it.
  const probeRaised = await expectRejection(
    () => send(client, oracle, 'prove_recipient', []),
    ['the_caller_is_not_a_credent_recipient'],
    async () => asBig(await view(oracle, 'owed_to', [client.address]), 'owed_to'),
  )
  check(probeRaised, 'a wallet cannot even raise a probe for itself')
  const selfAnswered = await expectRejection(
    () => send(client, oracle, 'confirm_recipient', []),
    ['the_caller_is_not_a_credent_recipient', 'no_probe_outstanding', 'caller_is_the_transaction_origin'],
    provenFlag,
  )
  check(selfAnswered, 'and it cannot answer one')
  const selfProven = await view(oracle, 'is_proven', [client.address])
  check(selfProven === false, 'a wallet cannot mark itself proven on this network')

  console.log(`\ncontract holds ${gen(await balanceOf(oracle))} at the end`)
  console.log(`oracle ${oracle}`)
  console.log(`claimant ${claimant}`)
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
