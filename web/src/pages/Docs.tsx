import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { PARAMETER_NOTES } from '../content/parameters'
import { CREDENT_POLICY } from '../core/policy'
import { repeatPenalty } from '../core/simulate'
import { formatBond, formatCount, formatDuration } from '../core/format'

const policy = CREDENT_POLICY
const penalty = repeatPenalty(policy)

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

const GROUPS: Group[] = [
  {
    id: 'protocol',
    title: 'How the protocol works',
    blurb: 'Four steps, none of which take the agent’s word for anything.',
    sections: [
      {
        id: 'engagement-closes',
        title: '1. An engagement closes',
        body: (
          <p>
            Two parties commit to a scope before the work starts. The scope is hashed on open, so
            the standard being graded against cannot be rewritten once the outcome is known.
          </p>
        ),
      },
      {
        id: 'counterparty-attests',
        title: '2. A counterparty attests',
        body: (
          <p>
            Only a party to the engagement can attest, once, and they post a bond to do it. The
            attestation is prose: what was promised, what arrived.
          </p>
        ),
      },
      {
        id: 'validators-grade',
        title: '3. Validators grade it in consensus',
        body: (
          <p>
            GenLayer validators independently read the attestation against the committed scope and
            grade two things separately — the outcome, and how well the claims were supported.
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
          <p>
            Weighted, decayed, and shrunk toward neutral, the grades become one number. That number
            decides how much an agent must post to take on work.
          </p>
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
              history toward it. A single glowing review cannot mint a perfect agent — it takes
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
              more for geometrically less — at the damping cap the cost per unit of weight is
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
              <Link to="/lab">weight lab</Link> — drop confidence below{' '}
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
            Substantiation below {policy.minSubstantiated} contributes nothing at all — not a
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
            to reach byte-identical results, and a float would let them disagree in the last place —
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
              It is SHA-256 over the canonical JSON encoding of the scope string — ASCII-escaped, no
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
            Derived from content, never randomness — every validator has to build a byte-identical
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
    title: 'Bonds, slashing, and attacks',
    blurb: 'What the economic layer prices, and what it does not.',
    sections: [
      {
        id: 'bond-cost',
        title: 'What posting an attestation costs',
        body: (
          <p>
            The first attestation about a subject costs {formatBond(policy.minBond)}, doubling on
            each repeat from the same counterparty. A releasable bond stays locked for{' '}
            {formatDuration(policy.bondLockSeconds)} before reclaim, leaving room for a dispute to
            surface before the collateral leaves. At or above {policy.releaseFloor} substantiated it
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
              always pays the flat first-attestation bond — that is deliberate, because an honest
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
    blurb: 'Why the site recomputes rather than reads.',
    sections: [
      {
        id: 'recompute-not-read',
        title: 'Why this interface recomputes rather than reads',
        body: (
          <>
            <p>
              The numbers on this site are derived in your browser by the same steps the contract
              runs, ported function for function. That is more work than fetching a stored score,
              and it is the point: an interface that approximates the math would eventually quote a
              number the chain does not agree with, which is worse than showing nothing.
            </p>
            <p>
              The registry runs on fixture attestations while the contract is pre-deployment, so no
              deployment is being read and only the demo agents resolve. Sorting and filtering
              change nothing about how a score was derived.
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
            scoring math changes with it — the <Link to="/policy">policy table</Link> marks the
            departure.
          </p>
        ),
      },
    ],
  },
]

export default function Docs() {
  return (
    <div className="shell page docs">
      <aside className="docs__toc" aria-label="On this page">
        <p className="docs__toc-head">On this page</p>
        <ol className="docs__toc-list">
          {GROUPS.map((group) => (
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
            The rest of the site stays short on purpose — the interactive pages show the arithmetic
            happening and link back here for the reasoning. This is the reasoning.
          </p>
        </div>

        {GROUPS.map((group) => (
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
