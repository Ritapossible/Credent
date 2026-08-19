import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { PARAMETER_NOTES } from '../content/parameters'
import { repeatPenalty } from '../core/simulate'
import { collateralRateBp, collateralRequired } from '../core/collateral'
import { NEUTRAL_BP, type Policy } from '../core/policy'
import { bpToPercent, formatBond, formatCount, formatDuration } from '../core/format'

/**
 * The engagement the collateral examples are priced against.
 *
 * One hundred whole tokens: large enough that the two rates land on figures a
 * reader can hold in their head, and stated once so the two sentences that use
 * it cannot drift apart.
 */
const EXAMPLE_STAKE = 100n * 10n ** 18n
import { useEffectivePolicy } from '../chain/useOracle'
import { CONTRACT_ADDRESS, EXPLORER_URL, NETWORK } from '../chain/config'

/**
 * The long-form explanation, gathered in one place.
 *
 * Every other page carries a sentence and a link to the relevant anchor here, so
 * the interactive surfaces stay interactive and the reasoning is still on the
 * site rather than deleted. Section ids are the contract with those links: they
 * are what the anchors point at, and renaming one breaks an inbound link.
 */

interface Section {
  id: string
  title: string
  body: ReactNode
}

interface Group {
  id: string
  title: string
  blurb: string
  sections: Section[]
}

/**
 * The prose, given the parameters it is describing.
 *
 * A function rather than a constant because these paragraphs quote numbers, and
 * a number in documentation is a claim about the deployment. Built from the
 * policy read off the contract so the explanation and the chain cannot drift.
 */
function buildGroups(policy: Policy, penalty: number): Group[] {
  return [
  {
    id: 'protocol',
    title: 'How the protocol works',
    blurb: 'Four steps, none of which take the agent’s word for anything.',
    sections: [
      {
        id: 'engagement-closes',
        title: '1. Both parties commit to a scope',
        body: (
          <>
            <p>
              The client proposes a scope and names a provider. The scope is hashed on open, so the
              standard being graded against cannot be rewritten once the outcome is known.
            </p>
            <p>
              A proposal is not yet an engagement: the named provider has to accept it before
              anything can proceed. That step is what stops attestation being usable against a
              stranger - without it anyone could name you as their counterparty, close the
              engagement alone, and have you graded on work you never agreed to. Only the provider
              can accept, and they accept a scope whose digest is already committed.
            </p>
            <p>
              Either party can then close it, which is what opens attestation.
            </p>
          </>
        ),
      },
      {
        id: 'counterparty-attests',
        title: '2. A counterparty attests',
        body: (
          <p>
            Only a party to the engagement can attest, once, and they post a bond to do it - a bond
            the contract checks before it pays a model to read anything, so an underfunded
            attestation is refused rather than graded. The attestation is prose: what was promised,
            what arrived.
          </p>
        ),
      },
      {
        id: 'validators-grade',
        title: '3. Validators grade it in consensus',
        body: (
          <p>
            GenLayer validators independently read the attestation against the committed scope and
            grade two things separately - the outcome, and how well the claims were supported.
            Leader and validator readings have to land within{' '}
            <strong>±{policy.confidenceTol}</strong> of each other on every graded field, which is
            tight enough to catch real disagreement and loose enough that two honest readings of the
            same prose still agree.
          </p>
        ),
      },
      {
        id: 'score-sets-collateral',
        title: '4. The score sets the collateral',
        body: (
          <>
            <p>
              Weighted, decayed, and shrunk toward neutral, the grades become one number. That
              number decides how much an agent must post to take on the next job - not as advice to
              whoever is reading it, but as a gate in the contract.
            </p>
            <p>
              A client opening an engagement declares what the work is worth. When the named
              provider accepts it, the contract reads their score, converts it to a rate, and
              refuses the acceptance unless the transaction carries that share of the declared
              value. At the deployed policy that is{' '}
              <strong>{bpToPercent(policy.collateralCeilingBp)}</strong> of the stake for an agent
              with no record and <strong>{bpToPercent(policy.collateralFloorBp)}</strong> for a
              perfect one. Reputation is the difference between those two numbers, in money.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'decisions',
    title: 'The design decisions that matter',
    blurb: 'Three choices that keep the number honest.',
    sections: [
      {
        id: 'unknown-is-not-bad',
        title: 'Unknown is not bad',
        body: (
          <>
            <p>
              An agent with no attestations scores exactly 50, and the prior pulls every thin
              history toward it. A single glowing review cannot mint a perfect agent - it takes
              sustained, independent evidence to move off neutral.
            </p>
            <p>
              The prior is {formatCount(policy.priorWeight)} bp, which is three full attestations
              worth of inertia. Treating an absent record as a bad one would be the easier design
              and the wrong one: it would punish every new entrant for existing, and it would make
              the score unable to distinguish "we have no idea" from "we know this went badly".
            </p>
          </>
        ),
      },
      {
        id: 'volume-is-not-standing',
        title: 'Volume is not standing',
        body: (
          <>
            <p>
              Each further attestation from the same counterparty about the same agent is worth half
              the last, while its bond doubles. Buying reputation from one voice costs geometrically
              more for geometrically less - at the damping cap the cost per unit of weight is
              roughly <strong>{formatCount(Math.round(penalty))}×</strong> what the first
              attestation paid.
            </p>
            <p>
              The two curves are deliberately pointed in opposite directions. Weight halves on
              repeat and the bond doubles on repeat, so cost per unit of weight rises as the square.
              You can see the whole shape of it on the <Link to="/attack">attack cost</Link> page.
            </p>
          </>
        ),
      },
      {
        id: 'criticism-is-never-punished',
        title: 'Criticism is never punished',
        body: (
          <>
            <p>
              Bonds are slashed on unsubstantiated claims, never on negative ones. A scathing,
              well-evidenced attestation is entirely safe to write.
            </p>
            <p>
              This is the single most load-bearing asymmetry in the design. Slashing on sentiment
              would turn the oracle into a praise machine: the rational move for any counterparty
              would be to write something mild regardless of what happened, and the score would
              stop carrying information. Keying the slash on substantiation instead means the only
              thing that costs you money is asserting something you cannot support.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'scoring',
    title: 'The scoring math',
    blurb: 'What one attestation is worth, and why it is worth that.',
    sections: [
      {
        id: 'confidence-gates',
        title: 'Why confidence gates instead of scaling',
        body: (
          <>
            <p>
              Substantiation is a judgement about the <em>evidence</em>; confidence is a judgement
              about the <em>judgement</em>. Multiplying weight by confidence would blend the two and
              let a hesitant-but-correct reading quietly count for less than a certain-but-shakier
              one.
            </p>
            <p>
              A floor keeps the two separable: below it the reading is discarded, above it the
              evidence speaks for itself. Gated attestations still show up at 0% weight rather than
              disappearing, because an attestation that was made and then discarded is a different
              fact from one that was never made. Try it on the{' '}
              <Link to="/lab">weight lab</Link> - drop confidence below{' '}
              {policy.minConfidence} and the contribution goes to zero, not to a fraction.
            </p>
          </>
        ),
      },
      {
        id: 'floors-not-discounts',
        title: 'Floors are floors, not discounts',
        body: (
          <p>
            Substantiation below {policy.minSubstantiated} contributes nothing at all - not a
            reduced weight, zero. A claim with no support is not worth partial credit. Below the
            floor the reading simply is not reliable enough to be worth anything, and past the
            slash floor of {policy.slashFloor} it costs the attester their bond.
          </p>
        ),
      },
      {
        id: 'decay-curve',
        title: 'How an attestation fades',
        body: (
          <p>
            Whole half-lives are a bit shift; the remainder is linearly interpolated between
            neighbouring halvings. That makes the curve a ramp rather than a staircase an agent
            could time a submission around. The half-life is{' '}
            {formatDuration(policy.halfLifeSeconds)}.
          </p>
        ),
      },
      {
        id: 'integer-arithmetic',
        title: 'Integer arithmetic throughout',
        body: (
          <p>
            Every parameter is an integer, and every derived figure stays one. Two validators have
            to reach byte-identical results, and a float would let them disagree in the last place -
            which in consensus is not a rounding difference, it is a failed block. Basis points give
            four decimal places of resolution without ever leaving integers.
          </p>
        ),
      },
    ],
  },
  {
    id: 'commitments',
    title: 'Commitments and digests',
    blurb: 'What proves the bar did not move after the fact.',
    sections: [
      {
        id: 'scope-digest',
        title: 'The scope digest',
        body: (
          <>
            <p>
              The scope digest is what proves the bar did not move. It is committed when an
              engagement opens, so a disappointed client cannot retrofit the standard they are
              grading against, and an agent cannot argue the goalposts after a miss.
            </p>
            <p>
              It is SHA-256 over the canonical JSON encoding of the scope string - ASCII-escaped, no
              separator whitespace, matching Python's <code>json.dumps</code> byte for byte. A
              vague scope is allowed but self-defeating: it produces low substantiation later, and
              that is a floor rather than a discount. Build one on the{' '}
              <Link to="/scope">scope builder</Link>.
            </p>
          </>
        ),
      },
      {
        id: 'attestation-salt',
        title: 'The attestation salt',
        body: (
          <p>
            Derived from content, never randomness - every validator has to build a byte-identical
            prompt, and a random salt would make that impossible. It is still unpredictable to the
            attester, because it commits to a scope digest they do not solely control. Addresses are
            case-folded before hashing, so a checksummed address and its lowercase spelling land in
            the same bucket.
          </p>
        ),
      },
    ],
  },
  {
    id: 'economics',
    title: 'Collateral, bonds, slashing, and attacks',
    blurb: 'What the economic layer prices, and what it does not.',
    sections: [
      {
        id: 'work-collateral',
        title: 'What taking on work costs',
        body: (
          <>
            <p>
              Collateral and the bond are different mechanisms and it is worth keeping them apart.
              The bond prices <em>attesting</em>: an attester posts it, and it doubles per repeat
              about the same subject. Collateral prices <em>working</em>: the agent taking the job
              posts it, and it falls as their score rises. Only the second one is what the score is
              for.
            </p>
            <p>
              The rate is a straight line between two policy parameters -{' '}
              {bpToPercent(policy.collateralCeilingBp)} of the declared value at a score of 0,{' '}
              {bpToPercent(policy.collateralFloorBp)} at 100, and{' '}
              {bpToPercent(collateralRateBp(NEUTRAL_BP, policy))} for an agent with no history,
              which sits at the neutral 50. On a {formatBond(EXAMPLE_STAKE)} engagement that is{' '}
              {formatBond(collateralRequired(NEUTRAL_BP, EXAMPLE_STAKE, policy))} for the unknown
              agent against {formatBond(collateralRequired(10000, EXAMPLE_STAKE, policy))} for the
              one with a full record: the same work, unlocked with a fraction of the capital.
            </p>
            <p>
              Nobody reaches zero. The floor is why a bought score cannot be converted into
              unlimited leverage - the bond curve an attacker pays to manufacture a reputation rises
              geometrically, while the most that reputation can ever save them is the distance
              between the two rates.
            </p>
          </>
        ),
      },
      {
        id: 'collateral-forfeit',
        title: 'When collateral is forfeited',
        body: (
          <>
            <p>
              The client's attestation settles it. Work graded below{' '}
              {bpToPercent(policy.collateralForfeitBp)} fulfilled forfeits the collateral to the
              client, who claims it in a separate call; anything else releases it back to the
              provider. Nothing moves during grading itself - the attestation only marks the
              outcome, so a failed consensus round cannot strand or duplicate a payment.
            </p>
            <p>
              Forfeiture is not the client's decision. It takes an attestation substantiated at or
              above {policy.releaseFloor} and confident at or above {policy.minConfidence} - the
              same gates the score applies - so an attestation that carries no weight in the score
              cannot take an agent's money either. Without that, the cheapest attack on this
              contract would be an unevidenced accusation.
            </p>
            <p>
              A client who simply never attests cannot hold the capital either: once the engagement
              has been closed for {formatDuration(policy.bondLockSeconds)}, the provider releases it
              ungraded. Silence is not a weapon.
            </p>
          </>
        ),
      },
      {
        id: 'bond-cost',
        title: 'What posting an attestation costs',
        body: (
          <p>
            The first attestation about a subject costs {formatBond(policy.minBond)}, doubling on
            each repeat from the same counterparty. A releasable bond stays locked for{' '}
            {formatDuration(policy.bondLockSeconds)} before reclaim, leaving room for a dispute to
            surface before the money leaves. At or above {policy.releaseFloor} substantiated it
            comes back in full; below {policy.slashFloor} it is slashed; between the two it is
            returned but the attestation carries reduced weight.
          </p>
        ),
      },
      {
        id: 'slashing',
        title: 'What slashing keys on',
        body: (
          <p>
            Slashing keys on substantiation, never on sentiment. An attestation that asserted
            without support loses its bond; a negative attestation backed by evidence is never at
            risk. The bond stays locked for {formatDuration(policy.bondLockSeconds)} before reclaim
            either way.
          </p>
        ),
      },
      {
        id: 'attack-surface',
        title: 'What this does and does not defend against',
        body: (
          <>
            <p>
              The bond curve makes <em>repetition</em> expensive, not attestation. A fresh attester
              always pays the flat first-attestation bond - that is deliberate, because an honest
              new counterparty is indistinguishable from a fresh sybil at the moment they post.
            </p>
            <p>
              What stops the fleet is not the bond but the rest of the protocol: only a party to a
              closed engagement can attest, each attestation needs a committed scope and evidence
              that survives grading, and an unsubstantiated claim loses the bond outright. The bond
              prices the attack; the engagement requirement is what makes it work.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'parameters',
    title: 'Parameter reference',
    blurb:
      'Every value Credent deploys with, and why it is set there. The table on the policy page carries the numbers.',
    sections: PARAMETER_NOTES.map((note) => ({
      id: note.anchor,
      title: note.label,
      body: <p>{note.why}</p>,
    })),
  },
  {
    id: 'this-interface',
    title: 'About this interface',
    blurb: 'What is read from the chain, and what is recomputed.',
    sections: [
      {
        id: 'recompute-not-read',
        title: 'What is read from the chain, and what is recomputed',
        body: (
          <>
            <p>
              Every score, weight and attestation on this site is read from the deployed contract
              through its <code className="mono">@gl.public.view</code> methods. The score beside an
              agent is the one <code className="mono">get_report</code> returned, not a local
              approximation of it, so the site cannot quote a number the chain disagrees with.
            </p>
            <p>
              One thing is recomputed in your browser: the <em>derivation</em> under each
              attestation - the base weight, the repeat damping, the decay loss. The contract
              returns the final weight but not its decomposition, so those steps are re-run locally
              by a TypeScript port of the engine. The port is pinned to the Python implementation by
              3,421 parity vectors across thirteen function families; if the two ever disagree the
              build fails rather than the interface drifting. Where a recomputed total and the chain's own
              disagree at runtime, the chain's value is what gets displayed.
            </p>
            <p>
              The registry is assembled by walking every attestation the contract holds and grouping
              them by subject, which is what an indexer would do and is honest at this scale. There
              is no cache between the chain and what you see; reloading re-reads it.
            </p>
          </>
        ),
      },
      {
        id: 'bond-switched-off',
        title: 'The one departure from the contract defaults',
        body: (
          <p>
            Credent sets a non-zero bond where the contract defaults to{' '}
            <code>minBond = 0</code>. At zero the economic layer is switched off entirely: attesting
            is free, so the curve that makes sybil attestation unprofitable never charges anyone. No
            scoring math changes with it - the <Link to="/policy">policy table</Link> marks the
            departure.
          </p>
        ),
      },
      {
        id: 'verified-on-chain',
        title: 'The lifecycle, run against the deployed contract',
        body: (
          <>
            <p>
              The six calls below are a real engagement, executed end to end on{' '}
              <strong>{NETWORK}</strong> against{' '}
              <code className="mono">{CONTRACT_ADDRESS || 'the deployed contract'}</code>. They are
              recorded here because a protocol description is a claim until someone runs it: these
              are the transaction ids, and they can be inspected rather than taken on trust.
            </p>
            <TransactionTable />
            <p>
              The second row is the one this contract exists for. The provider's acceptance was
              submitted one wei short of the quote and the chain refused it -{' '}
              <code className="mono">collateral_below_required</code> - so reputation-priced
              collateral is a gate that actually closes, not a figure the interface computes. The
              third row is the same call funded correctly: 8.75 GEN, being 8750bp of a 10 GEN stake
              at the neutral score of 5000, which is what an agent with no history pays.
            </p>
            <p>
              The attestation graded <strong>9800bp fulfilled</strong> on{' '}
              <strong>95</strong> substantiation, which moved the provider from 5000 to{' '}
              <strong>6154</strong> - the neutral prior pulled up by one positive grade rather than
              the grade itself. The same job then quoted <strong>7.308 GEN</strong> instead of 8.75:
              one well-evidenced attestation freed 1.44 GEN of working capital, which is the whole
              mechanism in a single number.
            </p>
            <p>
              <strong>One thing does not work on this network.</strong> The final call was accepted
              and every validator emitted the transfer, but a GenVM contract cannot pay an
              externally owned account on studionet. The emitted message becomes a contract call,
              which the node executes against the recipient and fails with{' '}
              <code className="mono">Contract 0x… not found</code>, leaving the value with the
              oracle. Seven routes were tried on a probe contract - both{' '}
              <code className="mono">emit_transfer</code> stages, <code className="mono">gl.Account</code>{' '}
              and <code className="mono">gl.chain.Account</code> (neither is exposed on this
              runner), and the <code className="mono">PostMessage</code> primitive underneath with
              empty-dict, empty-bytes and null calldata - and every one that emits at all fails
              identically, because the message kind is a call whatever it carries. This is not
              specific to collateral: <code className="mono">reclaim_bond</code> has always had it,
              hidden behind a 14-day lock nobody had waited out. Everything deciding <em>who</em> is
              owed what is on chain and correct; the transfer waits on a network that applies it.
            </p>
          </>
        ),
      },
      ],
    },
  ]
}

/**
 * The verified lifecycle, as transaction ids.
 *
 * Hard-coded on purpose. These are a historical record of one run against one
 * deployment - reading them from the chain would make them whatever happened
 * most recently, which is not what a reference is for.
 */
const VERIFIED_RUN = [
  {
    call: 'open_engagement',
    hash: '0x264ad243298beacc6173c8e344d59277fdb52a775ebd1425f4e9a84d293b7d66',
    note: 'Stake declared at 10 GEN',
  },
  {
    call: 'accept_engagement',
    hash: '0xb207e2d2c992c3f0370bf416dd4b8634c711b6b1d853da3eed22385473437256',
    note: 'Refused: one wei short of the 8.75 GEN quote (collateral_below_required)',
  },
  {
    call: 'accept_engagement',
    hash: '0x93f893e8a7be2fa90d23ff387da5fe3ca5b85867b00b17e1844949ddf24c0af9',
    note: 'Accepted with 8.75 GEN posted, priced at 8750bp off a score of 5000',
  },
  {
    call: 'close_engagement',
    hash: '0x6c93edcdd45e79c5ee616a1fb35aa765c5a683d0711b4030fe730042d4cf673a',
    note: 'Opens attestation, and starts the collateral dispute window',
  },
  {
    call: 'attest',
    hash: '0x1ff479d4f64c4079c43ac1a5b034983eea700a084697be85e5b6a217c1f67d68',
    note: 'Graded in consensus: fulfilled 9800bp, substantiated 95, confidence 91',
  },
  {
    call: 'release_collateral',
    hash: '0xf17c34ab2943c69a1cef052268665bab855a38253e5daccd02e5625c4188a10d',
    note: 'Contract accepted it and emitted the transfer; see the note below on payouts',
  },
]

function TransactionTable() {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Call</th>
            <th scope="col">Transaction</th>
            <th scope="col">What it shows</th>
          </tr>
        </thead>
        <tbody>
          {VERIFIED_RUN.map((entry) => (
            <tr key={entry.call}>
              <td>
                <code className="mono">{entry.call}</code>
              </td>
              <td className="mono docs__hash">
                {EXPLORER_URL ? (
                  <a href={`${EXPLORER_URL}/tx/${entry.hash}`} target="_blank" rel="noreferrer noopener">
                    {entry.hash}
                  </a>
                ) : (
                  entry.hash
                )}
              </td>
              <td className="muted">{entry.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Docs() {
  const { policy } = useEffectivePolicy()
  const penalty = repeatPenalty(policy)
  const groups = useMemo(() => buildGroups(policy, penalty), [policy, penalty])

  return (
    <div className="shell page docs">
      <aside className="docs__toc" aria-label="On this page">
        <p className="docs__toc-head">On this page</p>
        <ol className="docs__toc-list">
          {groups.map((group) => (
            <li key={group.id}>
              <a href={`#${group.id}`}>{group.title}</a>
            </li>
          ))}
        </ol>
      </aside>

      <div className="docs__body">
        <div className="section-head">
          <p className="eyebrow eyebrow--pill">Documentation</p>
          <h1>How Credent works, in full</h1>
          <p className="lede">
            The rest of the site stays short on purpose - the interactive pages show the arithmetic
            happening and link back here for the reasoning. This is the reasoning.
          </p>
        </div>

        {groups.map((group) => (
          <section key={group.id} className="docs__group">
            <h2 id={group.id} className="docs__group-title">
              {group.title}
            </h2>
            <p className="muted docs__blurb">{group.blurb}</p>

            {group.sections.map((section) => (
              <article key={section.id} className="docs__section">
                <h3 id={section.id} className="docs__section-title">
                  {section.title}
                </h3>
                <div className="docs__prose">{section.body}</div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
