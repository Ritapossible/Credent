/**
 * Drive a real engagement against the **submitted deployment**.
 *
 *   CREDENT_KEYDIR=… VITE_GENLAYER_NETWORK=studionet npm run livedemo
 *
 * `npm run settlement` deploys its own throwaway oracle every run, with the bond
 * lock at zero so one pass can reach every path. That is the right call for a
 * test — it isolates runs from each other — but it leaves the addresses in
 * `deployments.json` carrying nothing but view reads. Anyone opening the
 * submitted contract in the explorer sees a contract that has never been used,
 * which is a fair reason to doubt every claim made about it.
 *
 * So this script settles a real engagement against the deployed address itself
 * and prints every transaction hash. Afterwards the explorer shows the payout
 * path working on the contract that was actually submitted.
 *
 * Two things the production policy puts out of reach, and neither is a defect:
 *
 *   - `min_bond` is 1 GEN rather than the test policy's 0.01, so attesting here
 *     costs real balance. That is the anti-sybil price the design argues for.
 *   - `bond_lock_seconds` is 1209600 — fourteen days — so `reclaim_bond` cannot
 *     be exercised in a single run. `npm run settlement` covers it against a
 *     zero-lock instance. The bond entitlement is still visible via `owed_to`.
 */

import { createAccount, createClient } from 'genlayer-js'
import { studionet, testnetBradbury } from 'genlayer-js/chains'
import { TransactionStatus } from 'genlayer-js/types'
import type { GenLayerTransaction, Hash } from 'genlayer-js/types'
import { readFileSync } from 'node:fs'

import { addressArg } from '../src/chain/oracle'
import { outcomeOf } from '../src/chain/wallet'

const NETWORK = process.env.VITE_GENLAYER_NETWORK ?? 'studionet'
const MANIFEST = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
) as Record<string, { address: string; rpc: string }>

const spec = MANIFEST[NETWORK]
if (!spec) {
  console.error(`${NETWORK} is not in deployments.json`)
  process.exit(2)
}
const ORACLE = spec.address
const RPC = spec.rpc
const CHAIN = RPC.includes('studio') ? studionet : testnetBradbury
const EXPLORER = RPC.includes('studio')
  ? 'https://explorer-studio.genlayer.com'
  : 'https://explorer-bradbury.genlayer.com'

const KEYDIR = process.env.CREDENT_KEYDIR
if (!KEYDIR) {
  console.error('Set CREDENT_KEYDIR to a directory holding client.key. Nothing here prints key material.')
  process.exit(2)
}
const key = (name: string): `0x${string}` =>
  readFileSync(`${KEYDIR}/${name}.key`, 'utf8').trim() as `0x${string}`

const GEN = 10n ** 18n
const gen = (v: bigint): string => {
  const whole = v / GEN
  const frac = (v % GEN).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac} GEN` : `${whole} GEN`
}

let failures = 0
const check = (ok: boolean, what: string): boolean => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
  return ok
}

const account = createAccount(key('client'))
const client = createClient({ chain: CHAIN, account, endpoint: RPC })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const balanceOf = async (address: string): Promise<bigint> => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  })
  return BigInt((await res.json()).result)
}

/** Wait out the node's own rate limiter; see the note in settlement.ts. */
async function submit<T>(fn: () => Promise<T>, attempts = 25): Promise<T> {
  let wait = 2_000
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (!/(-32005|node is at capacity|gas rate limit exceeded)/.test(text) || attempt >= attempts) throw err
      const advised = Number(/retryAfterMs"?\s*:\s*(\d+)/.exec(text)?.[1] ?? 0)
      const delay = Math.max(advised + 250, wait)
      console.log(`         node at capacity; waiting ${Math.round(delay / 1000)}s (${attempt}/${attempts})`)
      await sleep(delay)
      wait = Math.min(wait * 2, 15_000)
    }
  }
}

type Sent = { hash: string; receipt: unknown }

async function call(
  address: string,
  functionName: string,
  args: unknown[],
  value = 0n,
  label = functionName,
): Promise<Sent> {
  const hash = await submit(() =>
    client.writeContract({ address: address as `0x${string}`, functionName, args: args as never[], value }),
  )
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as Hash, status: TransactionStatus.ACCEPTED, interval: 5_000, retries: 200,
  })
  console.log(`    ${label}`)
  console.log(`      ${EXPLORER}/tx/${String(hash)}`)
  // A transaction the contract *rejected* still reaches ACCEPTED: consensus
  // agreed on the rejection, which is a successful outcome for the network and
  // a refusal for the caller. Reading only the status therefore reports a
  // working guard as a guard that did not fire -- which is exactly what an
  // earlier draft of this script did, on a run where the contract had refused
  // correctly with `[EXPECTED] caller_is_the_transaction_origin`. The outcome
  // lives in the leader receipt, and `outcomeOf` is the same reader the site
  // and the settlement suite use.
  const outcome = outcomeOf(receipt as GenLayerTransaction)
  if (!outcome.ok) {
    throw new Error(`${functionName} rejected by the contract${outcome.reason ? `: ${outcome.reason}` : ''}`)
  }
  return { hash: String(hash), receipt }
}

const view = <T>(address: string, functionName: string, args: unknown[] = []): Promise<T> =>
  client.readContract({ address: address as `0x${string}`, functionName, args: args as never[] }) as Promise<T>

const asBig = (v: unknown): bigint => BigInt(v as string | number | bigint)

/** Wait for a value to settle, rather than reading once and trusting it. */
async function settleTo(read: () => Promise<bigint>, done: (v: bigint) => boolean, ms = 15 * 60 * 1000) {
  const deadline = Date.now() + ms
  let current = await read()
  let announced = 0
  const started = Date.now()
  while (!done(current) && Date.now() < deadline) {
    await sleep(10_000)
    const waited = Math.floor((Date.now() - started) / 1000)
    if (waited - announced >= 60) { announced = waited; console.log(`         ...waiting (${waited}s)`) }
    current = await read()
  }
  return current
}

async function expectRefusal(fn: () => Promise<unknown>, what: string): Promise<boolean> {
  try {
    await fn()
    return check(false, `${what} — it was NOT refused`)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    const reason = /\[EXPECTED\] ([a-z_]+)/.exec(text)?.[1]
    if (reason) console.log(`      refused: ${reason}`)
    else console.log(`      refused (this network reports no reason string)`)
    return check(true, what)
  }
}

// --- the run ---------------------------------------------------------------

console.log(`network   ${NETWORK}`)
console.log(`oracle    ${ORACLE}   <- the submitted deployment, not a throwaway`)
console.log(`          ${EXPLORER}/address/${ORACLE}`)
console.log(`client    ${account.address}  ${gen(await balanceOf(account.address))}`)

const policy = await view<Record<string, unknown>>(ORACLE, 'get_policy')
console.log(`min_bond  ${gen(asBig(policy.min_bond))}   bond_lock ${policy.bond_lock_seconds}s`)

// A recipient that can be paid. `emit_transfer` credits a contract and not a
// wallet, measured both ways, so a party expecting settlement has to be one.
console.log(`\ndeploying a claimant contract to receive the payout`)
const claimantSource = readFileSync(new URL('./claimant.py', import.meta.url))
const deployHash = await submit(() =>
  client.deployContract({ code: claimantSource, args: [ORACLE], leaderOnly: false }),
)
const deployReceipt = await client.waitForTransactionReceipt({
  hash: deployHash as Hash, status: TransactionStatus.ACCEPTED, interval: 5_000, retries: 300,
})
const CLAIMANT = ((deployReceipt as { data?: { contract_address?: string } }).data?.contract_address ??
  (deployReceipt as { recipient?: string }).recipient) as string
for (let i = 0; i < 40; i += 1) {
  try { await view(CLAIMANT, 'get_oracle'); break } catch { await sleep(5_000) }
}
console.log(`claimant  ${CLAIMANT}`)
console.log(`          ${EXPLORER}/address/${CLAIMANT}`)

const stake = GEN
const id = `livedemo-${Date.now()}`

console.log(`\n=== ${id} — a settlement on the deployed contract ===`)
await call(ORACLE, 'open_engagement', [id, addressArg(CLAIMANT, 'provider'),
  'Deliver a Python script that de-duplicates a CSV of orders on order id, ' +
  'keeping the most recent timestamp, and writes the result sorted by order id.',
  stake], 0n, 'open_engagement — the client commits scope and stake')

const quote = await view<Record<string, unknown>>(ORACLE, 'collateral_quote',
  [addressArg(CLAIMANT, 'provider'), stake])
const required = asBig(quote.required)
console.log(`    quoted ${gen(required)} collateral at ${quote.rate_bp}bp for an agent with no record`)

const oracleBefore = await balanceOf(ORACLE)
await call(CLAIMANT, 'accept', [id], required, 'accept — the provider posts collateral through its contract')
await settleTo(() => balanceOf(ORACLE), (v) => v >= oracleBefore + required)
check((await balanceOf(ORACLE)) - oracleBefore === required, `the contract took exactly ${gen(required)} of collateral`)

await call(ORACLE, 'close_engagement', [id], 0n, 'close_engagement — the client marks the work delivered')

// Attest before releasing. On the production policy `bond_lock_seconds` is
// fourteen days, and an *ungraded* engagement only frees its collateral after
// that dispute window — a client who declines to grade must not be able to hold
// an agent's capital forever, but nor can the provider walk out of a job nobody
// has assessed yet. `npm run settlement` deploys with the lock at zero so one
// pass reaches every path; here the ordinary route is the graded one.
//
// The first draft of this script skipped straight to `release_collateral` and
// reported a failure when nothing was credited. The contract was right and the
// script was wrong: the call was refused with `collateral_held`, correctly.
console.log(`\n  the attestation — an LLM grades the work, in consensus`)
const bond = asBig(policy.min_bond)
const overpay = GEN / 20n
const walletOwedBefore = asBig(await view(ORACLE, 'owed_to', [account.address.toLowerCase()]))
await call(ORACLE, 'attest', [
  id,
  'The script was delivered and run against the full 12,000-row file. It ' +
    'de-duplicated on order id keeping the latest timestamp, wrote orders_clean.csv ' +
    'sorted by order id, and finished in about 4 seconds. The README covers how to ' +
    'run it and states that malformed rows are skipped with a count reported at the end.',
  'orders_clean.csv checked against a manual pandas de-duplication of the same ' +
    'input: identical row count (11,842) and identical ordering. Timed over three ' +
    'runs at 3.9s, 4.1s and 4.0s. README reviewed and it documents both the ' +
    'invocation and the malformed-row behaviour.',
], bond + overpay, `attest — the client posts a ${gen(bond)} bond and ${gen(overpay)} over`)

// The overpaid bond comes back as an entitlement to the client's *wallet*, which
// is the case `assign_to` exists for and is exercised at the end of this run.
const walletOwed = await settleTo(
  async () => asBig(await view(ORACLE, 'owed_to', [account.address.toLowerCase()])),
  (v) => v >= walletOwedBefore + overpay,
)
check(walletOwed - walletOwedBefore === overpay,
  `the client wallet was credited the ${gen(overpay)} it overpaid`)

const graded = await settleTo(
  async () => {
    const e = await view<Record<string, unknown>>(ORACLE, 'get_engagement', [id])
    return String(e.collateral_state) === 'held' ? 0n : 1n
  },
  (v) => v === 1n,
  20 * 60 * 1000,
)
const engagement = await view<Record<string, unknown>>(ORACLE, 'get_engagement', [id])
const state = String(engagement.collateral_state)
console.log(`    collateral_state = ${state}`)
if (graded !== 1n) {
  console.error('    the attestation did not record in time; raise the wait and re-run')
  process.exit(1)
}

console.log(`\n  the payout`)
const owedBefore = asBig(await view(ORACLE, 'owed_to', [CLAIMANT.toLowerCase()]))
// Measured across the release call alone. Comparing against the balance from
// before the engagement was a bug in an earlier draft of this script: the
// attestation pays a bond into the same contract in between, so the total had
// legitimately risen by more than the collateral and the check read that as a
// fault. What this asserts is the property that matters -- crediting an
// entitlement moves no value at all.
const heldBeforeRelease = await balanceOf(ORACLE)
if (state === 'releasable') {
  await call(CLAIMANT, 'release', [id], 0n, 'release_collateral — the grade cleared, so the provider reclaims it')
} else {
  await call(ORACLE, 'claim_collateral', [id], 0n, 'claim_collateral — the grade forfeited, so the client takes it')
}
const creditedTo = state === 'releasable' ? CLAIMANT : account.address
const owedAfter = await settleTo(
  async () => asBig(await view(ORACLE, 'owed_to', [creditedTo.toLowerCase()])),
  (v) => v >= (state === 'releasable' ? owedBefore : walletOwed) + required,
)
check(owedAfter >= required, `the entitlement rose by ${gen(required)}`)
check((await balanceOf(ORACLE)) === heldBeforeRelease,
  'and the contract holds exactly what it held before — crediting moves no value')

// A forfeited grade credits the client's wallet, which cannot receive value at
// all. `assign_to` is how it directs that credit into a contract that can.
if (state !== 'releasable') {
  await call(ORACLE, 'assign_to', [addressArg(CLAIMANT, 'assign_to.recipient')], 0n,
    'assign_to — the wallet moves its credit to a contract that can receive')
  await settleTo(async () => asBig(await view(ORACLE, 'owed_to', [CLAIMANT.toLowerCase()])), (v) => v >= required)
}

await call(CLAIMANT, 'prove', [], 0n, 'prove_recipient — the oracle probes the recipient, which answers')
const proven = await settleTo(
  async () => ((await view<boolean>(ORACLE, 'is_proven', [CLAIMANT.toLowerCase()])) ? 1n : 0n),
  (v) => v === 1n,
)
check(proven === 1n, 'the claimant is a proven recipient')

const claimantBefore = await balanceOf(CLAIMANT)
await call(CLAIMANT, 'claim', [], 0n, 'withdraw — the only method that moves value')
await settleTo(async () => asBig(await view(ORACLE, 'owed_to', [CLAIMANT.toLowerCase()])), (v) => v === 0n)
const claimantAfter = await settleTo(() => balanceOf(CLAIMANT), (v) => v >= claimantBefore + required)
console.log(`    claimant  ${gen(claimantBefore)} -> ${gen(claimantAfter)}`)
check(claimantAfter - claimantBefore === required, `the claimant received the whole entitlement (${gen(required)})`)
check(asBig(await view(ORACLE, 'owed_to', [CLAIMANT.toLowerCase()])) === 0n, 'the entitlement was zeroed')

// The wallet's own entitlement, moved and then collected. This is the path the
// app offers a browser wallet by default, and the reason a wallet is never
// asked to receive value directly.
const walletCredit = asBig(await view(ORACLE, 'owed_to', [account.address.toLowerCase()]))
if (walletCredit > 0n) {
  console.log(`\n  the client wallet's own credit — ${gen(walletCredit)}`)
  const before = await balanceOf(CLAIMANT)
  await call(ORACLE, 'assign_to', [addressArg(CLAIMANT, 'assign_to.recipient')], 0n,
    'assign_to — moves the entitlement, not the money; it emits nothing and cannot fail')
  await settleTo(async () => asBig(await view(ORACLE, 'owed_to', [CLAIMANT.toLowerCase()])), (v) => v >= walletCredit)
  check(asBig(await view(ORACLE, 'owed_to', [account.address.toLowerCase()])) === 0n,
    'the wallet entitlement is spent, not duplicated')
  await call(CLAIMANT, 'claim', [], 0n, 'withdraw — the contract collects what the wallet assigned it')
  const after = await settleTo(() => balanceOf(CLAIMANT), (v) => v >= before + walletCredit)
  check(after - before === walletCredit, `the claimant received the wallet's ${gen(walletCredit)}`)
}

console.log(`\n  the payout guard, on the deployed contract`)
check((await view<boolean>(ORACLE, 'is_proven', [account.address.toLowerCase()])) === false,
  'an ordinary wallet is not a proven recipient')
await expectRefusal(() => call(ORACLE, 'withdraw', [], 0n, 'withdraw from a wallet (expected to be refused)'),
  'withdraw from an unproven wallet is refused, not attempted')
await expectRefusal(
  () => call(ORACLE, 'assign_to',
    [addressArg('0x0000000000000000000000000000000000000000', 'assign_to.recipient')], 0n,
    'assign_to the zero address (expected to be refused)'),
  'assigning to the zero address is refused')

const liabilities = await view<Record<string, unknown>>(ORACLE, 'liabilities')
console.log(`\n  liabilities  total_owed ${gen(asBig(liabilities.total_owed))}  held ${gen(asBig(liabilities.held))}`)

console.log(`\noracle    ${EXPLORER}/address/${ORACLE}`)
console.log(`claimant  ${EXPLORER}/address/${CLAIMANT}`)
if (failures > 0) {
  console.error(`\nlivedemo FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log(`\nlivedemo ok — a settlement completed on the submitted deployment`)
