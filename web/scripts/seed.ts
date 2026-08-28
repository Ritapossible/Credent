/**
 * Populate a deployed oracle with real engagements so the registry is not empty.
 *
 * A freshly deployed contract renders as "no attestations yet", which is honest
 * and useless to look at. This runs the full lifecycle -- open, accept, close,
 * attest -- against the configured deployment, so the site has agents with
 * scores the contract actually derived rather than fixtures.
 *
 *   VITE_CONTRACT_ADDRESS=0x... VITE_GENLAYER_NETWORK=studionet \
 *   CREDENT_KEYDIR=/path/to/keys npm run seed
 *
 * Every provider is a throwaway wallet funded from the client key, because the
 * registry is only interesting with several distinct subjects in it. The keys
 * are derived from SEED_SALT so a re-run reuses the same agents rather than
 * scattering half-funded wallets across the network.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createAccount, createClient } from 'genlayer-js'
import { createWalletClient, http } from 'viem'
import { TransactionStatus } from 'genlayer-js/types'

import { CHAIN, CONFIG_ERROR, EXPLORER_URL, NETWORK } from '../src/chain/config'
import { addressArg } from '../src/chain/oracle'
import { outcomeOf } from '../src/chain/wallet'
import { startGasProxy } from './gasProxy'

if (CONFIG_ERROR) {
  console.error(CONFIG_ERROR)
  process.exit(2)
}

const ORACLE = process.env.VITE_CONTRACT_ADDRESS?.trim() ?? ''
if (!/^0x[0-9a-fA-F]{40}$/.test(ORACLE)) {
  console.error('set VITE_CONTRACT_ADDRESS to the deployed oracle')
  process.exit(2)
}

const KEYDIR = process.env.CREDENT_KEYDIR
if (!KEYDIR) {
  console.error('set CREDENT_KEYDIR to a directory holding client.key')
  process.exit(2)
}

const GEN = 10n ** 18n
const STAKE = GEN / 10n // 0.1 GEN of declared work value, so collateral is small
const SEED_SALT = process.env.SEED_SALT ?? 'credent-registry-seed-v1'
const RPC = CHAIN.rpcUrls.default.http[0]

let endpoint: string | undefined

const gen = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4)} GEN`

async function balanceOf(address: string): Promise<bigint> {
  const res = await fetch(endpoint ?? RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  })
  const body = (await res.json()) as { result?: string }
  return BigInt(body.result ?? '0x0')
}

/** A provider wallet derived from the salt, so re-running reuses the same agent. */
function derivedKey(index: number): `0x${string}` {
  const digest = createHash('sha256').update(`${SEED_SALT}:${index}`).digest('hex')
  return `0x${digest}` as `0x${string}`
}

function clientFor(privateKey: `0x${string}`) {
  const account = createAccount(privateKey)
  return { account, address: account.address as string, client: createClient({ chain: CHAIN, account, endpoint }) }
}

type Party = ReturnType<typeof clientFor>

async function send(from: Party, to: string, fn: string, args: never[], value = 0n) {
  const hash = await from.client.writeContract({ address: to as `0x${string}`, functionName: fn, args, value })
  const receipt = await from.client.waitForTransactionReceipt({
    hash: hash as Parameters<typeof from.client.waitForTransactionReceipt>[0]['hash'],
    status: TransactionStatus.ACCEPTED,
    interval: 5_000,
    retries: 300,
  })
  const outcome = outcomeOf(receipt)
  if (!outcome.ok) throw new Error(`${fn} rejected: ${outcome.reason ?? 'unknown'}`)
  return outcome
}

async function view(fn: string, args: never[] = []) {
  const anon = clientFor(derivedKey(999))
  return anon.client.readContract({ address: ORACLE as `0x${string}`, functionName: fn, args })
}

/** Send native value wallet-to-wallet. That direction works; contract-to-wallet does not. */
async function fund(from: Party, to: string, amount: bigint) {
  // A plain value transfer, sent with viem rather than the GenLayer client,
  // which exposes no wallet for this. Wallet-to-wallet works; it is
  // contract-to-wallet that does not, which is why settlement credits instead.
  const wallet = createWalletClient({
    account: from.account as never,
    chain: CHAIN as never,
    transport: http(endpoint ?? RPC),
  })
  const hash = await wallet.sendTransaction({ to: to as `0x${string}`, value: amount } as never)
  for (let i = 0; i < 60; i += 1) {
    if ((await balanceOf(to)) >= amount) return hash
    await new Promise((r) => setTimeout(r, 5_000))
  }
  return hash
}

const AGENTS = [
  {
    scope:
      'Reconcile 90 days of Stripe payouts against the ledger, flag any settlement ' +
      'that differs by more than 1 cent, and deliver a CSV of exceptions with cause codes.',
    claim:
      'Delivered on day 4 against a 5 day deadline. 412 exceptions found across 18,­903 ' +
      'payouts, each with a cause code. Two were genuine duplicate refunds worth 1,240 USD.',
    evidence:
      'Exception CSV reconciled against our own ledger export: identical row count and ' +
      'identical totals to the cent. The two duplicate refunds were confirmed with Stripe ' +
      'support and recovered. Delivered 2026-08-14, deadline was 2026-08-15.',
  },
  {
    scope:
      'Migrate the analytics warehouse from Redshift to ClickHouse with no query ' +
      'regressions on the top 50 dashboards and under 30 minutes of read downtime.',
    claim:
      'Migration completed with 11 minutes of read downtime. All 50 dashboards verified ' +
      'against Redshift output. Median query time fell from 4.2s to 0.9s.',
    evidence:
      'Downtime measured from the load balancer cutover log, 11m04s. Dashboard parity was ' +
      'checked by diffing result sets for all 50 against the Redshift snapshot; all matched. ' +
      'Query timings are p50 over the following week from the ClickHouse system log.',
  },
  {
    scope:
      'Audit the payments service for PCI scope creep and deliver a remediation plan ' +
      'ranked by exposure, with owners and dates.',
    claim:
      'Audit delivered a week late. Found 6 issues, 2 critical, but the remediation plan ' +
      'named no owners and left every date as TBD.',
    evidence:
      'The findings themselves check out and the two critical ones were real: card data ' +
      'was reaching an unsegmented log aggregator. But the deliverable specified owners and ' +
      'dates, and it has neither, so the plan cannot be actioned as delivered.',
  },
]

async function main() {
  const clientParty = clientFor(readFileSync(`${KEYDIR}/client.key`, 'utf8').trim() as `0x${string}`)
  console.log(`network   ${NETWORK}`)
  console.log(`oracle    ${ORACLE}`)
  if (EXPLORER_URL) console.log(`          ${EXPLORER_URL}/address/${ORACLE}`)
  console.log(`client    ${clientParty.address}  ${gen(await balanceOf(clientParty.address))}`)

  const before = Number(await view('attestation_count'))
  console.log(`\nattestations already recorded: ${before}`)

  for (const [index, agent] of AGENTS.entries()) {
    const provider = clientFor(derivedKey(index))
    console.log(`\n=== agent ${index + 1}  ${provider.address}`)

    const quote = (await view('collateral_quote', [
      addressArg(provider.address, 'collateral_quote.provider'),
      STAKE,
    ] as never)) as { required?: unknown }
    const required = BigInt(String(quote.required ?? 0))
    console.log(`  collateral ${gen(required)} on a ${gen(STAKE)} stake`)

    // Enough for the collateral plus gas for the accept.
    const need = required + GEN / 20n
    const have = await balanceOf(provider.address)
    if (have < need) {
      console.log(`  funding ${gen(need - have)}`)
      await fund(clientParty, provider.address, need - have)
    }

    const id = `seed-${SEED_SALT}-${index}`
    await send(clientParty, ORACLE, 'open_engagement', [
      id,
      addressArg(provider.address, 'open_engagement.provider'),
      agent.scope,
      STAKE,
    ] as never)
    console.log('  opened')
    await send(provider, ORACLE, 'accept_engagement', [id] as never, required)
    console.log('  accepted')
    await send(clientParty, ORACLE, 'close_engagement', [id] as never)
    console.log('  closed')

    // The attestation is the thing the registry displays, and the grade is the
    // contract's own -- an LLM call inside the consensus round, so this is the
    // slow step.
    const bond = BigInt(
      String(
        await view('bond_for_next', [
          addressArg(clientParty.address, 'bond_for_next.attester'),
          addressArg(provider.address, 'bond_for_next.subject'),
        ] as never),
      ),
    )
    await send(clientParty, ORACLE, 'attest', [id, agent.claim, agent.evidence] as never, bond)
    console.log(`  attested (bond ${gen(bond)})`)

    const report = (await view('get_report', [
      addressArg(provider.address, 'get_report.subject'),
    ] as never)) as Record<string, unknown>
    console.log(`  score ${String(report.score_bp)}bp over ${String(report.counted)} attestation(s)`)
  }

  const after = Number(await view('attestation_count'))
  console.log(`\nattestations now: ${after} (was ${before})`)
  console.log('the registry should list every subject above')
}

const proxy = await startGasProxy(RPC, { onEstimateFailure: 50_000_000n, cap: 60_000_000n })
endpoint = proxy.url
try {
  await main()
} finally {
  await proxy.close()
}
process.exit(0)
