/**
 * Checks on the site that need no browser, no chain and no test framework.
 *
 * Two of the defects this file exists for shipped:
 *
 *   The page validated a recipient with `normalizeAddress(x) !== null`. That
 *   helper returns a *string*, so the expression is always true: the error hint
 *   was unreachable and the button enabled on any text.
 *
 *   The page branched on `solvency().backed`, a field the contract had stopped
 *   returning. `undefined === true` is false, so a money screen told every user
 *   their value had already left, including when it had not. TypeScript could
 *   not catch it because the value is decoded from `unknown`.
 *
 * The second is the dangerous shape, so the main check here is structural: every
 * key the chain layer decodes out of a contract view must be a key that view
 * actually returns, compared against the contract source rather than a copy of
 * it.
 */

import { readFileSync } from 'node:fs'

import { isAddress } from '../src/core/address'
import { formatBond } from '../src/core/format'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

console.log('address validation')
for (const good of [
  '0x0000000000000000000000000000000000000001',
  '0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd',
  '0XAA34E14A0E0B2FDD8AD10F06BC0907FA0B1D02BD',
  '  0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd  ',
]) {
  check(`accepts ${good.trim().slice(0, 12)}…`, isAddress(good))
}
for (const bad of [
  '', 'not-an-address', '0x', '0xzz34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd',
  '0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02', '0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02BdAB',
  'aA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd',
]) {
  check(`rejects ${JSON.stringify(bad).slice(0, 22)}`, !isAddress(bad))
}

console.log('\nbalance formatting')
// A non-zero balance must never read as nothing owed on a payout screen.
check('1 wei does not render as 0', !/^0 /.test(formatBond(1n)), formatBond(1n))
check('zero still renders as 0', formatBond(0n).startsWith('0 '), formatBond(0n))
check('a normal amount is unchanged', formatBond(875000000000000000n).startsWith('0.875'), formatBond(875000000000000000n))

console.log('\ncontract views the site decodes')

/** The literal keys a contract view returns, read from the contract itself. */
function returnedKeys(source: string, method: string): string[] {
  const at = source.indexOf(`def ${method}(`)
  if (at < 0) return []
  const after = source.slice(at)
  const start = after.indexOf('return {')
  if (start < 0) return []
  const body = after.slice(start, start + 800)
  return [...body.matchAll(/["']([a-z_]+)["']\s*:/g)].map((m) => m[1])
}

// Names the site calls on-chain. Listed rather than inferred: a misspelled
// method would otherwise fail the `def` test, be filtered out as "not a contract
// method", and pass.
const CONTRACT_CALLS = new Set([
  'assign_to',
  'withdraw',
  'prove_recipient',
  'confirm_recipient',
  'is_proven',
  'owed_to',
  'liabilities',
])

const contract = readFileSync(new URL('../../reputation_oracle.py', import.meta.url), 'utf8')
const oracleTs = readFileSync(new URL('../src/chain/oracle.ts', import.meta.url), 'utf8')

// Every key the TS decoder pulls out of `liabilities` must exist on-chain.
const decoded = [...oracleTs.matchAll(/\w+\(source, '([a-z_]+)', 'liabilities'\)/g)].map((m) => m[1])
const onchain = returnedKeys(contract, 'liabilities')
check('liabilities: the view exists on-chain', onchain.length > 0, onchain.join(', '))
for (const key of decoded) {
  check(`liabilities: '${key}' is returned by the contract`, onchain.includes(key))
}
check('liabilities: the site decodes something', decoded.length > 0, decoded.join(', '))

// The site must not reference views or fields the contract dropped.
for (const gone of ['solvency', 'in_flight_to', 'resolve_in_flight', 'backed']) {
  check(`the site no longer references '${gone}'`, !oracleTs.includes(`'${gone}'`) && !oracleTs.includes(`${gone}:`))
}

// Prose drifts too. A comment describing `reclaim_in_flight` as "the recovery
// path" survived the method's removal and read, to anyone auditing the page, as
// a recovery mechanism the contract does not have -- the same shape of false
// claim that got this project rejected once. So the sweep covers every file the
// page is built from, not just the decoder, and it covers comments.
const pageFiles = ['../src/pages/Payouts.tsx', '../src/chain/oracle.ts', '../src/chain/wallet.ts']
const pageText = pageFiles
  .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
  .join('\n')
const removedMethods = ['resolve_in_flight', 'reclaim_in_flight', 'withdraw_to', 'in_flight_to']
for (const gone of removedMethods) {
  check(
    `no page text mentions '${gone}', which the contract does not have`,
    !pageText.includes(gone),
  )
}

// And every contract method the pages do name must actually exist on-chain.
const named = [...pageText.matchAll(/'([a-z_]{4,})'/g)]
  .map((m) => m[1])
  .filter((n) => contract.includes(`def ${n}(`) || CONTRACT_CALLS.has(n))
for (const method of new Set(named)) {
  check(`'${method}' exists on the contract`, contract.includes(`def ${method}(`))
}

// `withdraw` takes no arguments now; a stale `[true]` would be silently wrong.
const walletTs = readFileSync(new URL('../src/chain/wallet.ts', import.meta.url), 'utf8')
check(
  "withdraw is submitted with no arguments",
  /submit\(account, 'withdraw', \[\]\)/.test(walletTs),
  'the contract dropped recipient_is_a_contract',
)

// Addresses drift. Three copies of the deployed pair came apart once and a
// reviewer read the stale pair as proof the fix had never been deployed. This
// is the offline half of that guard -- `verifyDeployment` proves the bytes
// match the chain, and this proves every file naming an address names the same
// one. It runs in CI, where the network checks cannot.
const manifest = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
) as Record<string, { address?: string }>
const expected = Object.entries(manifest)
  .filter(([k]) => !k.startsWith('_'))
  .map(([network, entry]) => [network, entry.address as string] as const)

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

for (const [network, address] of expected) {
  check(`README names the deployed ${network} address`, readme.includes(address), address)
}
check(
  '.env.example points at the studionet deployment',
  envExample.includes(manifest.studionet.address as string),
  manifest.studionet.address,
)

// And no *other* address may be presented as a deployment. Throwaway contracts
// from a suite run are fine -- they are labelled as such -- so this only checks
// the lines that introduce the deployments.
const deployLines = readme
  .split('\n')
  .filter((l) => /Deployed on|Testnet Bradbury\*\* at|GenLayer Studio\*\* at/.test(l))
  .join('\n')
const advertised = [...deployLines.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0])
const known = new Set(expected.map(([, a]) => a))
for (const address of advertised) {
  check(`the README's deployment line names a current address`, known.has(address), address)
}

console.log()
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('uicheck ok')
