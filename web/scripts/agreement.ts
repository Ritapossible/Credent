/**
 * Does validator agreement preserve the bond and collateral outcomes?
 *
 *   npm run agreement
 *
 * No key, no gas: `agreement_check` is a view. It runs against every deployment
 * in `deployments.json`, so the rule is checked where it actually settles money
 * rather than where it is committed.
 *
 * This exists because the rule is otherwise unreachable from outside. The
 * comparison lives inside `gl.vm.run_nondet`, which is only entered when two
 * validators genuinely produce different grades — not something a caller can
 * arrange. So before the view, the fix could be read in the source and pinned
 * by unit tests, and could not be *exercised* against a deployment at all. A
 * reviewer asked for exactly this property; it should be one command to check.
 *
 * The interesting cases are the ones where the arithmetic agrees and the money
 * does not. `confidence_tol` is 20 on a 0-100 scale and `slash_floor` is 20, so
 * a leader reporting `substantiated` 10 and a validator computing 30 are within
 * tolerance while one confiscates the attester's bond and the other returns it.
 * The same shape holds for `fulfilled` against `collateral_forfeit_bp`.
 */

import { readFileSync } from 'node:fs'

type Grade = { verdict: string; fulfilled: number; substantiated: number; confidence: number }
type Answer = {
  agree: boolean
  bond_mine: string
  bond_theirs: string
  collateral_mine: string
  collateral_theirs: string
  confidence_tol: number
  slash_floor: number
  collateral_forfeit_bp: number
}

const MANIFEST = JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
) as Record<string, { address: string; rpc: string }>

let failures = 0
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok   ${what}`)
  else {
    failures += 1
    console.error(`  FAIL ${what}`)
  }
}

const grade = (verdict: string, fulfilled: number, substantiated: number, confidence: number): Grade => ({
  verdict,
  fulfilled,
  substantiated,
  confidence,
})

/**
 * Calldata for a view call, in the shape `gen_call` expects. Written out rather
 * than pulled from genlayer-js so this script needs no account and no client:
 * a reviewer should be able to run it against a public RPC with nothing set up.
 */
async function agreementCheck(rpc: string, address: string, mine: Grade, theirs: Grade): Promise<Answer> {
  const { createClient, createAccount } = await import('genlayer-js')
  const chains = await import('genlayer-js/chains')
  const chain = rpc.includes('studio') ? chains.studionet : chains.testnetBradbury
  // A throwaway account: a view call is not signed, but the client wants one.
  const { generatePrivateKey } = await import('genlayer-js')
  const client = createClient({ chain, account: createAccount(generatePrivateKey()), endpoint: rpc })
  return (await client.readContract({
    address: address as `0x${string}`,
    functionName: 'agreement_check',
    args: [mine, theirs],
  })) as Answer
}

for (const [net, spec] of Object.entries(MANIFEST)) {
  if (net.startsWith('_')) continue
  console.log(`\n${net}  ${spec.address}`)

  // Within tolerance, opposite sides of slash_floor.
  {
    const r = await agreementCheck(spec.rpc, spec.address, grade('partial', 5000, 10, 80), grade('partial', 5000, 30, 80))
    console.log(`  substantiated 10 vs 30 (tolerance ${r.confidence_tol}, slash_floor ${r.slash_floor})`)
    console.log(`    bond: ${r.bond_mine} vs ${r.bond_theirs}`)
    check(r.bond_mine !== r.bond_theirs, 'the two grades settle the bond differently')
    check(r.agree === false, 'so they do not count as agreement')
  }

  // Within tolerance, opposite sides of collateral_forfeit_bp.
  {
    const r = await agreementCheck(spec.rpc, spec.address, grade('partial', 1500, 90, 90), grade('partial', 3500, 90, 90))
    console.log(`  fulfilled 1500 vs 3500 (forfeit at ${r.collateral_forfeit_bp}bp)`)
    console.log(`    collateral: ${r.collateral_mine} vs ${r.collateral_theirs}`)
    check(r.collateral_mine !== r.collateral_theirs, 'the two grades settle the collateral differently')
    check(r.agree === false, 'so they do not count as agreement')
  }

  // The control. A rule that rejected these would fail every honest round, so
  // the outcome guard has to be narrower than "any difference at all".
  {
    const r = await agreementCheck(spec.rpc, spec.address, grade('partial', 5000, 60, 80), grade('partial', 5400, 70, 85))
    console.log(`  substantiated 60 vs 70, fulfilled 5000 vs 5400 (same side of both lines)`)
    check(
      r.bond_mine === r.bond_theirs && r.collateral_mine === r.collateral_theirs,
      'both outcomes match',
    )
    check(r.agree === true, 'so they do count as agreement')
  }

  // A verdict mismatch is never agreement, whatever the numbers say.
  {
    const r = await agreementCheck(spec.rpc, spec.address, grade('fulfilled', 9000, 90, 90), grade('unfulfilled', 9000, 90, 90))
    check(r.agree === false, 'a differing verdict is not agreement, whatever the numbers')
  }
}

console.log()
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('agreement ok - every case decided on the outcome, not the arithmetic')
