/**
 * Deploy the oracle under the production policy, and record where it went.
 *
 *   CREDENT_KEYDIR=... VITE_GENLAYER_NETWORK=testnet-bradbury node scripts/deploy.mjs
 *
 * Deployment was done by hand before this existed, which is how the addresses
 * and the documentation drifted apart once. This writes `deployments.json`
 * itself so the record cannot disagree with what was sent.
 *
 * Bradbury refuses an oversized contract on transaction *pubdata* rather than
 * on gas, so it takes the minified artifact and a gas shim; studionet takes the
 * readable one. Which is which is `deployments.json`'s to say, not this file's.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createAccount, createClient } from 'genlayer-js'
import { studionet, testnetBradbury } from 'genlayer-js/chains'

const NETWORK = process.env.VITE_GENLAYER_NETWORK ?? 'studionet'
const KD = process.env.CREDENT_KEYDIR
if (!KD) { console.error('set CREDENT_KEYDIR'); process.exit(2) }

const DEPLOYMENTS = new URL('../../deployments.json', import.meta.url)
const all = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const entry = all[NETWORK]
if (!entry) { console.error(`unknown network ${NETWORK}`); process.exit(2) }

const CHAIN = NETWORK.includes('bradbury') ? testnetBradbury : studionet
const RPC = entry.rpc
const GEN = 10n ** 18n

/** The production policy, in constructor order. Not the defaults: those leave
 *  `min_bond` at zero, which makes an attestation free to write. */
const POLICY = [
  7776000n,   // half_life_seconds
  30000n,     // prior_weight
  25n,        // min_substantiated
  50n,        // min_confidence
  20n,        // confidence_tol
  8n,         // repeat_shift_cap
  GEN,        // min_bond - 1 GEN
  20n,        // slash_floor
  50n,        // release_floor
  1209600n,   // bond_lock_seconds
  900n,       // withdrawal_settle_seconds
  15000n,     // collateral_ceiling_bp
  2500n,      // collateral_floor_bp
  2500n,      // collateral_forfeit_bp
]

/** Bradbury under-estimates gas for a contract this size and the client does
 *  not correct it, so estimates are multiplied in front of the node.
 *
 *  The four numbers below are `scripts/gasProxy.ts`'s, and they were paid for
 *  once already: the cap especially. A deploy asking near the block gas limit
 *  is not a safe over-estimate -- it is unminable, and it fails by being
 *  silently dropped from the mempool, with no receipt and nothing to look up.
 *  Bradbury also answers `null` rather than estimating for a contract this
 *  size, which is why an unusable answer takes the ceiling instead of the
 *  multiplier. */
function gasProxy() {
  const srv = createServer((q, s) => {
    let b = ''
    q.on('data', c => { b += c })
    q.on('end', async () => {
      let p = null
      try { p = JSON.parse(b) } catch {}
      const send = x => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(x)) }
      try {
        const u = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b, signal: AbortSignal.timeout(120000) })
        const d = await u.json()
        if (p?.method === 'eth_estimateGas') {
          let estimate = null
          if (typeof d.result === 'string' || typeof d.result === 'number') {
            try { estimate = BigInt(d.result) } catch { estimate = null }
          }
          let wanted
          if (estimate === null) { wanted = 20_000_000n; delete d.error }
          else { const g = estimate * 5n; wanted = g > 20_000_000n ? g : 20_000_000n }
          // 15,000,000, not gasProxy.ts's 30,000,000. Bradbury rejects a
          // deploy of this contract at 20M and above with `gas limit too
          // high` (-32602) and accepts it at 15M -- measured by sweeping,
          // after 30M and 60M were both refused. It is a per-transaction
          // ceiling rather than the block's: the block gas limit reads
          // 100,000,000. Actual consumption is around 2,000,000.
          const CAP = BigInt(process.env.CREDENT_GAS_CAP ?? '15000000')
          if (wanted > CAP) wanted = CAP
          d.result = '0x' + wanted.toString(16)
          return send(d)
        }
        return send(d)
      } catch (e) {
        return send({ jsonrpc: '2.0', id: p?.id ?? null, error: { code: -32603, message: String(e) } })
      }
    })
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, stop: () => srv.close() })))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Bradbury answers `-32005` with a `retryAfterMs` under load. Honour it. */
async function submit(fn, attempts = 12) {
  let w = 2000
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      const t = String(e.message ?? e)
      if (!/(-32005|node is at capacity|gas rate limit)/.test(t) || i >= attempts) throw e
      await sleep(Math.max(Number(/retryAfterMs"?\s*:\s*(\d+)/.exec(t)?.[1] ?? 0) + 250, w))
      w = Math.min(w * 2, 20000)
    }
  }
}

const proxy = CHAIN === testnetBradbury ? await gasProxy() : null
const acct = createAccount(readFileSync(`${KD}/client.key`, 'utf8').trim())
const client = createClient({ chain: CHAIN, account: acct, ...(proxy ? { endpoint: proxy.url } : {}) })

// `CREDENT_ARTIFACT` overrides which file is sent, for comparing one build
// against another on the same network without touching deployments.json.
const artifactName = process.env.CREDENT_ARTIFACT ?? entry.artifact
const artifact = new URL(`../../${artifactName}`, import.meta.url)
const code = readFileSync(artifact)
console.log(`network   ${NETWORK}`)
console.log(`artifact  ${artifactName}  ${code.length} bytes`)
console.log(`deployer  ${acct.address}`)

try {
  const hash = await submit(() => client.deployContract({ code, args: POLICY, leaderOnly: false }))
  console.log(`tx        ${hash}`)
  const receipt = await client.waitForTransactionReceipt({ hash, status: 'FINALIZED', interval: 5000, retries: 240 })
  const address = receipt?.data?.contract_address ?? receipt?.contract_address
  if (!address) throw new Error(`no contract address in receipt: ${JSON.stringify(receipt).slice(0, 400)}`)
  console.log(`address   ${address}`)

  if (process.env.CREDENT_ARTIFACT) { console.log('\n(one-off artifact; deployments.json untouched)'); }
  else { all[NETWORK] = { ...entry, address }
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + '\n')
  console.log(`\ndeployments.json updated for ${NETWORK}`) }
} finally {
  proxy?.stop()
}
