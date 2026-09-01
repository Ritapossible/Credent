/**
 * Read the deployed contract through the site's own decoding layer.
 *
 * `npm run parity` proves the ported arithmetic agrees with the engine and
 * `npm run units` covers the helpers, but neither one ever meets a real chain
 * response. Every defect this project has shipped lived exactly there: a field
 * renamed on one side, an integer arriving as a string, an address encoded as
 * text. So this asks the live deployment for one of everything and decodes it
 * with the same functions the pages use.
 *
 * Needs a deployment to point at, so it is not part of CI:
 *   VITE_CONTRACT_ADDRESS=0x… npx esbuild scripts/livecheck.ts --bundle … && node
 */

import {
  attestationCount,
  bondForNext,
  collateralQuote,
  getAttestations,
  getEngagement,
  getPolicy,
  getReport,
} from '../src/chain/oracle'
import { collateralRateBp, collateralRequired } from '../src/core/collateral'
import { bpToScore, formatBond } from '../src/core/format'

const ENGAGEMENT = process.env.ENGAGEMENT
const PROVIDER = process.env.PROVIDER

let failures = 0
function check(condition: boolean, what: string) {
  if (condition) {
    console.log(`  ok   ${what}`)
  } else {
    failures += 1
    console.error(`  FAIL ${what}`)
  }
}

const policy = await getPolicy()
console.log('policy')
check(policy.collateralCeilingBp === 15000, `collateralCeilingBp = ${policy.collateralCeilingBp}`)
check(policy.collateralFloorBp === 2500, `collateralFloorBp = ${policy.collateralFloorBp}`)
check(policy.collateralForfeitBp === 2500, `collateralForfeitBp = ${policy.collateralForfeitBp}`)
check(policy.minBond === 10n ** 18n, `minBond = ${formatBond(policy.minBond)}`)
check(
  policy.withdrawalSettleSeconds === 900,
  `withdrawalSettleSeconds = ${policy.withdrawalSettleSeconds}s — reclaim waits this long before judging a withdrawal`,
)

console.log('registry')
const count = await attestationCount()
check(count >= 1, `attestation_count = ${count}`)
const page = await getAttestations(0, 50)
check(page.length === count, `one page decoded ${page.length} attestations`)
if (page[0]) {
  const a = page[0]
  check(a.gradeBp > 0 && a.substantiated > 0, `first attestation graded ${a.gradeBp}bp / ${a.substantiated}`)
  check(a.weight > 0, `weight ${a.weight}`)
}

if (PROVIDER) {
  console.log('report and quote')
  const report = await getReport(PROVIDER)
  check(report.scoreBp > 5000, `provider scores ${bpToScore(report.scoreBp)} (above the prior)`)

  const stake = 10n * 10n ** 18n
  const quote = await collateralQuote(PROVIDER, stake)
  check(quote.required > 0n, `quote ${formatBond(quote.required)} on a ${formatBond(stake)} stake`)
  check(quote.scoreBp === report.scoreBp, 'the quote prices off the same score get_report returns')

  // The port and the chain must agree on the conversion itself, not merely on
  // its inputs: this is the number the accept card shows before a wallet signs.
  check(
    collateralRateBp(report.scoreBp, policy) === quote.rateBp,
    `ported rate ${collateralRateBp(report.scoreBp, policy)}bp === chain rate ${quote.rateBp}bp`,
  )
  check(
    collateralRequired(report.scoreBp, stake, policy) === quote.required,
    `ported amount === chain amount (${formatBond(quote.required)})`,
  )

  const bond = await bondForNext(PROVIDER, PROVIDER)
  check(bond === policy.minBond, `bond_for_next quotes ${formatBond(bond)}`)
}

if (ENGAGEMENT) {
  console.log('engagement')
  const engagement = await getEngagement(ENGAGEMENT)
  check(engagement.state === 'closed', `state = ${engagement.state}`)
  check(engagement.stake === 10n * 10n ** 18n, `stake = ${formatBond(engagement.stake)}`)
  check(engagement.collateral > 0n, `collateral = ${formatBond(engagement.collateral)}`)
  check(engagement.collateralRateBp === 8750, `priced at ${engagement.collateralRateBp}bp`)
  check(engagement.scoreBp === 5000, `against a score of ${engagement.scoreBp} at accept time`)
  check(engagement.closedAt > 0, `closed_at = ${engagement.closedAt}`)
  check(
    ['returned', 'releasable', 'held', 'forfeit', 'claimed', 'none'].includes(
      engagement.collateralState,
    ),
    `collateral_state = ${engagement.collateralState}`,
  )
}

if (failures > 0) {
  console.error(`\nlivecheck FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nlivecheck ok - the site decodes the live deployment')
