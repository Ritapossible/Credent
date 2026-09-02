/**
 * Every transaction the README cites, checked against the chain it claims.
 *
 * The README's evidence is only worth anything if the hashes in it are real
 * and belong to the deployment `deployments.json` names. Those two drifted
 * apart once — addresses were updated by a redeploy while the tables under
 * them still cited the superseded pair — and a review read the stale rows as
 * proof a fix was never deployed. This is the check that would have caught it.
 *
 *   node scripts/checkreadme.mjs
 *
 * `gen_getTransactionReceipt` is the method that answers here: GenLayer
 * transactions do not resolve through `eth_getTransactionByHash`, and its
 * `recipient` field is the contract the transaction actually ran against.
 */
import { readFileSync } from 'node:fs'

const deployments = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
)
const NETWORKS = {
  bradbury: {
    rpc: deployments['testnet-bradbury'].rpc,
    oracle: deployments['testnet-bradbury'].address.toLowerCase(),
  },
  studio: {
    rpc: deployments.studionet.rpc,
    oracle: deployments.studionet.address.toLowerCase(),
  },
}

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const cited = [
  ...readme.matchAll(/explorer-(bradbury|studio)\.genlayer\.com\/tx\/(0x[0-9a-f]{64})/g),
].map(m => ({ net: m[1], hash: m[2] }))

/**
 * The two networks answer different methods, and neither answers the plain
 * Ethereum one usefully. Bradbury has `gen_getTransactionReceipt`, whose
 * `recipient` is the contract the transaction ran against. Studio does not
 * implement it, but its `eth_getTransactionByHash` returns a GenLayer-shaped
 * object carrying `to_address`.
 */
const LOOKUP = {
  bradbury: {
    method: 'gen_getTransactionReceipt',
    params: hash => [{ txId: hash }],
    target: r => r.recipient,
  },
  studio: {
    method: 'eth_getTransactionByHash',
    params: hash => [hash],
    target: r => r.to_address,
  },
}

/**
 * The addresses a transaction is allowed to have run against: the oracle
 * itself, plus every other address the README links on that network. The
 * walkthroughs deploy recipient contracts and call them directly, so those
 * are legitimate targets — what must not appear is a transaction against
 * some address the README never mentions.
 */
const linkedAddresses = net => new Set(
  [...readme.matchAll(
    new RegExp(`explorer-${net}\\.genlayer\\.com/address/(0x[0-9a-fA-F]{40})`, 'g'),
  )].map(m => m[1].toLowerCase()),
)

async function receipt(rpc, net, hash) {
  const how = LOOKUP[net]
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: how.method, params: how.params(hash),
    }),
    signal: AbortSignal.timeout(45000),
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error))
  return d.result
}

console.log(`${cited.length} transactions cited by the README`)
let bad = 0
for (const { net, hash } of cited) {
  const { rpc, oracle } = NETWORKS[net]
  const allowed = linkedAddresses(net)
  allowed.add(oracle)
  const short = hash.slice(0, 10)
  try {
    const rec = await receipt(rpc, net, hash)
    if (!rec) { console.log(`MISSING   ${net.padEnd(8)} ${short}`); bad++; continue }
    const to = (LOOKUP[net].target(rec) ?? '').toLowerCase()
    if (!allowed.has(to)) {
      console.log(`UNLINKED  ${net.padEnd(8)} ${short}  ran against ${to}`)
      bad++
    } else {
      const where = to === oracle ? 'the oracle' : to.slice(0, 10)
      console.log(`ok ${net.padEnd(8)} ${short}  ${where}`)
    }
  } catch (e) {
    console.log(`ERROR     ${net.padEnd(8)} ${short}  ${e.message ?? e}`)
    bad++
  }
}

if (bad) {
  console.log(`\n${bad} of ${cited.length} do not check out — the README is citing`)
  console.log('transactions that are not on the deployment it names.')
  process.exit(1)
}
console.log('\nreadme ok — every cited transaction is on the named deployment')
