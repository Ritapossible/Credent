/**
 * Does a contract-to-wallet transfer move a balance on this network?
 *
 * The smallest experiment that answers the reviewer's question, and the one the
 * full harness cannot reach while the real contract is too large to deploy.
 * Deploy a tiny contract, fund it, ask it to pay the caller, and watch the
 * contract's balance - the contract pays no gas, so its side of the transfer is
 * the number that can be asserted exactly.
 */
import { readFileSync } from 'node:fs'
import { createAccount, createClient } from 'genlayer-js'
import { testnetBradbury } from 'genlayer-js/chains'
import { TransactionStatus } from 'genlayer-js/types'
import { startGasProxy } from './gasProxy'

const RPC = testnetBradbury.rpcUrls.default.http[0]!
// Same contract as `settlement.ts`: keys live outside the repository and are
// named by environment, never hardcoded to one machine's home directory.
const KEYDIR = process.env.CREDENT_KEYDIR
if (!KEYDIR) {
  console.error('Set CREDENT_KEYDIR to a directory outside the repository holding client.key.')
  process.exit(2)
}
const GEN = 10n ** 18n
const gen = (w: bigint) => `${Number(w) / 1e18} GEN`

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const b = (await r.json()) as { result?: unknown; error?: unknown }
  if (b.result === undefined) throw new Error(`${method}: ${JSON.stringify(b.error)}`)
  return b.result
}
const balance = async (a: string) => BigInt((await rpc('eth_getBalance', [a, 'latest'])) as string)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const proxy = await startGasProxy(RPC)
console.log(`gas shim  ${proxy.url} -> ${RPC}`)

try {
  const key = readFileSync(`${KEYDIR}/client.key`, 'utf8').trim()
  const account = createAccount(key as `0x${string}`)
  const client = createClient({ chain: testnetBradbury, account, endpoint: proxy.url })
  console.log(`client    ${account.address}  ${gen(await balance(account.address))}`)

  const code = readFileSync(new URL('./payprobe.py', import.meta.url), 'utf8')
  console.log(`\ncontract source: ${code.length} bytes (the real one is 96,580)`)

  console.log('deploying PayProbe...')
  const hash = await client.deployContract({ code, args: [] })
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as never,
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 120,
  })
  // BigInt-safe: the receipt carries bigints and plain stringify throws on them,
  // which turned a diagnosable "where is the address" into an opaque TypeError.
  const dump = (v: unknown, n = 2000) =>
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2).slice(0, n)
  const r = receipt as Record<string, any>
  console.log('receipt keys:', Object.keys(r).join(', '))
  // Non-studio networks do not answer with `data.contract_address`; hunt for it.
  const addr =
    r?.data?.contract_address ??
    r?.contract_address ??
    r?.recipient ??
    r?.txDataDecoded?.contract_address
  if (!addr || /^0x0{40}$/i.test(String(addr))) {
    console.log('receipt:', dump(receipt))
    throw new Error(`no contract address; receipt dumped above`)
  }
  console.log(`DEPLOYED  ${addr}`)

  const fund = GEN / 10n // 0.1 GEN
  console.log(`\nfunding the contract with ${gen(fund)}`)
  const dep = await client.writeContract({
    address: addr as `0x${string}`,
    functionName: 'deposit',
    args: [],
    value: fund,
  })
  await client.waitForTransactionReceipt({
    hash: dep as never, status: TransactionStatus.ACCEPTED, interval: 5_000, retries: 120,
  })
  console.log(`contract holds ${gen(await balance(addr))}`)

  const before = await balance(addr)
  const meBefore = await balance(account.address)
  console.log(`\nasking for ${gen(fund)} back`)
  const pay = await client.writeContract({
    // `value` is required by the SDK's type even when sending nothing: this call
    // asks the contract to pay *out*, so it carries no value of its own.
    address: addr as `0x${string}`, functionName: 'payout', args: [fund] as never[], value: 0n,
  })
  console.log(`tx ${pay}`)
  await client.waitForTransactionReceipt({
    hash: pay as never, status: TransactionStatus.ACCEPTED, interval: 5_000, retries: 120,
  })

  // The payout is posted on finalization, after the receipt that authorised it.
  let after = before
  for (let i = 0; i < 60 && after >= before; i += 1) {
    await sleep(5_000)
    after = await balance(addr)
    if (i % 6 === 0) console.log(`   ...waiting (${(i + 1) * 5}s, contract ${gen(after)})`)
  }
  const meAfter = await balance(account.address)

  console.log(`\ncontract ${gen(before)} -> ${gen(after)}   (${gen(after - before)})`)
  console.log(`caller   ${gen(meBefore)} -> ${gen(meAfter)}   (${gen(meAfter - meBefore)})`)
  if (after < before) console.log('\nRESULT: the contract paid out. Contract-to-wallet transfer WORKS here.')
  else console.log('\nRESULT: the contract did NOT pay out. Same defect as studionet.')
} finally {
  await proxy.close()
}
