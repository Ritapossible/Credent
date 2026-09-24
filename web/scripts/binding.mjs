/**
 * The Explorer review's sentence, driven against the deployed contract.
 *
 *   "bind attestations to signed events or validator-retrievable artifacts
 *    before a counterparty's claim can redirect collateral."
 *
 * Two engagements, run for real, printing a transaction for every step.
 *
 *   1. The provider delivers and commits it. The client then writes a false,
 *      confident account of non-delivery and attests. The graders fetch the
 *      committed artifact, hash it against the digest the provider signed, and
 *      grade the work rather than the accusation. The collateral stays put.
 *
 *   2. The provider commits nothing. The same accusation now forfeits -- and
 *      not on the client's word: on the on-chain fact that no transaction
 *      signed by the provider says where the work is.
 *
 * The second half matters as much as the first. Binding a forfeit to an
 * artifact must not hand providers a way to keep collateral by never producing
 * one.
 */
import { readFileSync } from 'node:fs'
import { createAccount, createClient } from 'genlayer-js'
// From the same copy of the library the client uses: a CalldataAddress built
// by a different module instance is not recognised by the encoder, which
// reports it as `invalid calldata input '[object Object]'`.
import { CalldataAddress } from 'genlayer-js/types'
import { studionet, testnetBradbury } from 'genlayer-js/chains'

const NETWORK = process.env.VITE_GENLAYER_NETWORK ?? 'studionet'
const KD = process.env.CREDENT_KEYDIR
if (!KD) { console.error('set CREDENT_KEYDIR'); process.exit(2) }
const all = JSON.parse(readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'))
const entry = all[NETWORK]
const ORACLE = entry.address
const CHAIN = NETWORK.includes('bradbury') ? testnetBradbury : studionet
const EXPLORER = NETWORK.includes('bradbury')
  ? 'https://explorer-bradbury.genlayer.com'
  : 'https://explorer-studio.genlayer.com'

const GEN = 10n ** 18n
const gen = v => (Number(v) / 1e18).toFixed(6)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * The attestation `attest` just wrote, waited for rather than assumed.
 *
 * Reading `attestation_count` straight after the write can still answer the
 * pre-write value, and `get_attestation(count - 1)` is then an out-of-range
 * index that takes the read down rather than returning anything.
 */
async function latestAttestation(before) {
  for (let i = 0; i < 60; i++) {
    try {
      const n = Number(await view('attestation_count', []))
      if (n > before) return await view('get_attestation', [n - 1])
    } catch {
      // transient read failure; try again
    }
    await sleep(5000)
  }
  throw new Error(`attestation_count never rose past ${before}`)
}

const clientAcct = createAccount(readFileSync(`${KD}/client.key`, 'utf8').trim())
const provAcct = createAccount(readFileSync(`${KD}/provider.key`, 'utf8').trim())
const client = createClient({ chain: CHAIN, account: clientAcct })
const prov = createClient({ chain: CHAIN, account: provAcct })

const view = (fn, args = []) => client.readContract({ address: ORACLE, functionName: fn, args })

/** An `Address` parameter wants calldata, not a hex string: a view that is
 *  handed the string answers `execution failed` with nothing to read. */
const addr = hex => {
  const b = new Uint8Array(20)
  for (let i = 0; i < 20; i++) b[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16)
  return new CalldataAddress(b)
}

async function submit(who, fn, args, value = 0n) {
  for (let i = 1; ; i++) {
    try {
      const hash = await who.writeContract({ address: ORACLE, functionName: fn, args, value })
      await who.waitForTransactionReceipt({ hash, status: 'FINALIZED', interval: 5000, retries: 240 })
      console.log(`      ${EXPLORER}/tx/${hash}`)
      return hash
    } catch (e) {
      const t = String(e.message ?? e)
      // Studio intermittently answers an HTML gateway page instead of JSON,
      // which surfaces as a parse error rather than an RPC one. It is a
      // transient fault on their side and it has killed two runs, so it is
      // retried like the rate limits.
      const transient = /(-32005|capacity|rate limit|is not valid JSON|<!DOCTYPE|fetch failed|ETIMEDOUT|ECONNRESET)/.test(t)
      if (!transient || i >= 8) throw e
      await sleep(Math.min(2000 * 2 ** i, 20000))
    }
  }
}

/** The work itself, public and stable, and the digest of exactly those bytes. */
const URI = 'https://raw.githubusercontent.com/Ritapossible/credent/main/examples/orders_clean.py'
const DIGEST = '1eb2ebd5f2d0f517f37aa63f235408ed9311325d24785a0c32d4a670221013b1'

const SCOPE =
  'Deliver a Python script that reads orders.csv (about 12,000 rows), removes ' +
  'duplicate order ids keeping the most recent row by timestamp, and writes ' +
  'orders_clean.csv sorted by order id. Include a README covering how to run ' +
  'it and what it does with malformed rows.'

/**
 * Everything the attacker controls, set to its most convincing -- and held
 * identical across both engagements.
 *
 * That is the point of the comparison. The claim, the evidence, the scope, the
 * stake and the grader are the same in both runs; the only difference is
 * whether the provider committed a delivery. So whatever the two outcomes are,
 * the deliverable is what produced them.
 *
 * The evidence is written the way a real complaint is -- specific, dated,
 * checkable -- because a thin one fails on `release_floor` before the
 * deliverable is reached, and a gate that never fires proves nothing.
 */
const FALSE_CLAIM =
  'Nothing was ever delivered. The agreed repository was empty at the deadline, ' +
  'the provider stopped replying on the third day, and no script and no README ' +
  'appeared at any point. I checked twice and had a colleague confirm it.'

const EVIDENCE =
  'Timeline: engagement accepted on the 1st, deadline the 8th. I cloned the ' +
  'agreed repository on the 8th at 09:14 and again on the 9th at 17:40; both ' +
  'checkouts contained only the original README stub and no orders_clean.py. ' +
  '`git log` showed no commits after the 2nd. I emailed on the 4th, 6th and ' +
  '8th and received no reply after the 3rd. A colleague repeated the clone on ' +
  'the 9th and saw the same empty tree. No de-duplication script, no usage ' +
  'documentation, and nothing describing malformed-row handling was ever ' +
  'produced, so none of the committed scope was met.'

const STAKE = GEN  // 1 GEN: the collateral is a rate on this, and the point is the rule, not the size

async function engagement(id, { deliver }) {
  console.log(`\n  ${id}`)
  console.log(`    open_engagement — the client commits scope and stake`)
  await submit(client, 'open_engagement', [id, addr(provAcct.address), SCOPE, STAKE])

  const quote = await view('collateral_quote', [addr(provAcct.address), STAKE])
  const required = BigInt(quote.required)
  console.log(`    accept_engagement — the provider posts ${gen(required)} GEN of collateral`)
  await submit(prov, 'accept_engagement', [id], required)

  if (deliver) {
    console.log(`    submit_delivery — the provider's own signed transaction`)
    console.log(`      uri    ${URI}`)
    console.log(`      digest ${DIGEST}`)
    await submit(prov, 'submit_delivery', [id, URI, DIGEST])
  } else {
    console.log(`    (no submit_delivery — the provider commits nothing)`)
    // Wait the provider's fair chance out before closing. Close sooner and
    // this is `foreclosed` -- the client's doing -- which is scenario 3.
    const window = Number((await view('get_policy', [])).delivery_window_seconds)
    if (window > 0) {
      console.log(`    waiting out the ${window}s delivery window before closing`)
      for (let waited = 0; waited < window + 30; waited += 60) {
        await sleep(60_000)
        console.log(`         ...waiting (${waited + 60}s)`)
      }
    }
  }
  const committed = await view('delivery_of', [id])
  console.log(`      committed on chain: ${committed.committed}`)

  console.log(`    close_engagement`)
  await submit(client, 'close_engagement', [id])

  const attestedBefore = Number(await view('attestation_count', []))
  const bond = BigInt(await view('bond_for_next', [addr(clientAcct.address), addr(provAcct.address)]))
  console.log(`    attest — the client posts ${gen(bond)} GEN and accuses the provider of delivering nothing`)
  await submit(client, 'attest', [id, FALSE_CLAIM, EVIDENCE], bond)

  const graded = await latestAttestation(attestedBefore)
  const state = (await view('get_engagement', [id])).collateral_state
  console.log(`      delivery established by the graders: ${graded.delivery}`)
  console.log(`      grade: ${graded.verdict}  fulfilled ${graded.fulfilled}bp  substantiated ${graded.substantiated}`)
  console.log(`      collateral_state: ${state}`)
  return { state, delivery: graded.delivery, required }
}

console.log(`network   ${NETWORK}`)
console.log(`oracle    ${ORACLE}`)
console.log(`          ${EXPLORER}/address/${ORACLE}`)
console.log(`client    ${clientAcct.address}`)
console.log(`provider  ${provAcct.address}`)

const stamp = Date.now()
let failures = 0
const check = (ok, message) => { console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) failures++ }

console.log(`\n=== 1. the provider delivered, and the client says otherwise ===`)
const delivered = await engagement(`bind-ok-${stamp}`, { deliver: true })
check(delivered.delivery === 'verified', 'the graders fetched the committed artifact and it matched its digest')
check(delivered.state !== 'forfeit', 'a false accusation did not forfeit a delivered provider\'s collateral')

console.log(`\n    claim_collateral, expected to be refused`)
// A plain string, not calldata. `owed_to` used to be declared `recipient: str`
// and answered zero to anything else, so reading it with a `CalldataAddress`
// returned 0 whatever the books said -- and this check, which is the one that
// matters, passed on a run where the accuser *had* been credited 0.875 GEN.
// The contract takes both forms now; this reads it the way the ABI declares.
const owedBefore = BigInt(await view('owed_to', [clientAcct.address]))
try {
  await submit(client, 'claim_collateral', [`bind-ok-${stamp}`])
} catch (e) {
  console.log(`      refused: ${String(e.message ?? e).slice(0, 120)}`)
}
const owedAfter = BigInt(await view('owed_to', [clientAcct.address]))
check(owedAfter === owedBefore, `the accuser was credited nothing (${gen(owedBefore)} GEN before and after)`)

console.log(`\n=== 2. the provider committed no delivery at all ===`)
const nothing = await engagement(`bind-none-${stamp}`, { deliver: false })
check(nothing.delivery === 'absent', 'the absence of a signed delivery is what the graders saw')
check(nothing.state === 'forfeit', 'a provider who delivered nothing still forfeits')

console.log(`\n=== 3. the client closes at once, denying the provider the chance ===`)
const fid = `bind-fore-${stamp}`
console.log(`\n  ${fid}`)
console.log(`    open_engagement`)
await submit(client, 'open_engagement', [fid, addr(provAcct.address), SCOPE, STAKE])
const foreQuote = BigInt((await view('collateral_quote', [addr(provAcct.address), STAKE])).required)
console.log(`    accept_engagement — the provider posts ${gen(foreQuote)} GEN`)
await submit(prov, 'accept_engagement', [fid], foreQuote)
console.log(`    close_engagement — immediately, before any delivery can be committed`)
await submit(client, 'close_engagement', [fid])
console.log(`    submit_delivery — the provider tries anyway`)
try {
  await submit(prov, 'submit_delivery', [fid, URI, DIGEST])
} catch (e) {
  console.log(`      refused: ${String(e.message ?? e).slice(0, 80)}`)
}
// Judged on state rather than on an exception. A transaction the contract
// *rejected* still reaches ACCEPTED -- consensus agreeing on a refusal is a
// success for the network -- so a refused call does not throw here.
const foreCommitted = (await view('delivery_of', [fid])).committed
check(!foreCommitted, 'the commitment is frozen once the engagement closes')
const foreAttestedBefore = Number(await view('attestation_count', []))
const foreBond = BigInt(await view('bond_for_next', [addr(clientAcct.address), addr(provAcct.address)]))
console.log(`    attest — the same accusation, on a delivery the client foreclosed`)
await submit(client, 'attest', [fid, FALSE_CLAIM, EVIDENCE], foreBond)
const foreGrade = await latestAttestation(foreAttestedBefore)
const foreState = (await view('get_engagement', [fid])).collateral_state
console.log(`      delivery established by the graders: ${foreGrade.delivery}`)
console.log(`      collateral_state: ${foreState}`)
check(foreGrade.delivery === 'foreclosed', 'the absence is recorded as the client\'s doing, not the provider\'s')
check(foreState !== 'forfeit', 'a provider refused the chance to deliver keeps their collateral')

const foreOwedBefore = BigInt(await view('owed_to', [clientAcct.address]))
try { await submit(client, 'claim_collateral', [fid]) } catch (e) {
  console.log(`      claim refused: ${String(e.message ?? e).slice(0, 80)}`)
}
const foreOwedAfter = BigInt(await view('owed_to', [clientAcct.address]))
check(foreOwedAfter === foreOwedBefore,
  `the accuser was credited nothing (${gen(foreOwedBefore)} GEN before and after)`)

console.log(`\noracle    ${EXPLORER}/address/${ORACLE}`)
console.log(failures === 0
  ? '\nbinding ok — a claim alone no longer redirects collateral, a missing delivery still does,\n            and an absence the accuser manufactured does not'
  : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
