/**
 * Is the deployed contract the file in this repository?
 *
 *   npm run verify-deployment
 *   npm run verify-deployment -- studionet 0x...
 *
 * No key, no gas, no trust in anything the README says. GenLayer stores a
 * contract's Python source on-chain, so `gen_getContractCode` hands it back and
 * the two can be compared byte for byte.
 *
 * Worth its own script because "the source is fixed" and "the address is fixed"
 * are different claims, and a submission that quotes an address is making the
 * second one. This repository has already shipped a pair of addresses deployed
 * on the wrong policy once; a contract can just as easily be committed and never
 * redeployed.
 *
 * Studionet carries the full artifact and bradbury the minified one, which is
 * not a discrepancy: bradbury refuses the full-size source on transaction
 * pubdata rather than on gas, and `minify_contract.py` compares the two ASTs
 * with `ast.dump` before writing.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

type Target = { net: string; rpc: string; address: string; file: string }

/**
 * Read from `deployments.json` rather than repeated here.
 *
 * These addresses lived in three files once and drifted apart; a review then
 * read the stale pair as proof a deployed fix was missing. One file is the
 * only arrangement in which that cannot recur.
 */
const MANIFEST = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
) as Record<string, { address: string; rpc: string; artifact: string }>

const DEPLOYMENTS: Target[] = Object.entries(MANIFEST)
  .filter(([net]) => !net.startsWith('_'))
  .map(([net, spec]) => ({ net, rpc: spec.rpc, address: spec.address, file: spec.artifact }))

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/**
 * Studio takes a bare address; bradbury wants an object. Both shapes are tried
 * rather than branching on the network name, so a new endpoint that speaks
 * either one works without a code change.
 */
async function fetchCode(rpc: string, address: string): Promise<Buffer | null> {
  for (const params of [[address], [{ address }]]) {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_getContractCode', params }),
    })
    const payload = (await response.json()) as { result?: string }
    if (payload.result) return Buffer.from(payload.result, 'base64')
  }
  return null
}

async function main(): Promise<void> {
  const [net, address] = process.argv.slice(2)
  const targets = net
    ? DEPLOYMENTS.filter((t) => t.net === net).map((t) => ({ ...t, address: address ?? t.address }))
    : DEPLOYMENTS

  if (targets.length === 0) {
    console.error(`unknown network ${net}; try ${DEPLOYMENTS.map((t) => t.net).join(' or ')}`)
    process.exit(2)
  }

  let failures = 0
  for (const target of targets) {
    const onchain = await fetchCode(target.rpc, target.address)
    if (!onchain) {
      console.log(`${target.net}  ${target.address}\n  no code at this address\n`)
      failures += 1
      continue
    }

    const local = readFileSync(new URL(`../../${target.file}`, import.meta.url))
    const same = onchain.equals(local)

    console.log(`${target.net}  ${target.address}`)
    console.log(`  on-chain ${String(onchain.length).padStart(7)} bytes  ${sha256(onchain)}`)
    console.log(`  local    ${String(local.length).padStart(7)} bytes  ${sha256(local)}  ${target.file}`)
    console.log(`  ${same ? 'MATCH' : 'DIFFERS'}\n`)
    if (!same) failures += 1
  }

  if (failures > 0) {
    console.error(`${failures} deployment(s) do not match this repository`)
    process.exit(1)
  }
  console.log('every deployment is the source in this repository, byte for byte')
}

void main()
