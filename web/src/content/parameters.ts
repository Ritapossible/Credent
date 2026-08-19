import type { Policy } from '../core/policy'

/**
 * The reasoning behind each deployed parameter.
 *
 * This lives apart from both pages that use it because both need it and neither
 * owns it: the policy table renders the label and links to the anchor, the docs
 * page renders the prose under that anchor. Keeping one list means a parameter
 * cannot be renamed in the table and still be reachable in the docs.
 */
export interface ParameterNote {
  key: keyof Policy
  label: string
  /** Docs heading id, linked to from the policy table. */
  anchor: string
  why: string
}

export const PARAMETER_NOTES: ParameterNote[] = [
  {
    key: 'halfLifeSeconds',
    label: 'Half-life',
    anchor: 'half-life',
    why: 'Age at which an attestation is worth half what it was. Long enough that a real track record persists, short enough that a reputation has to be maintained rather than banked.',
  },
  {
    key: 'priorWeight',
    label: 'Neutral prior',
    anchor: 'neutral-prior',
    why: 'Three full attestations worth of inertia toward 50. This is what stops one review from producing a perfect agent, and what makes "unknown" read differently from "bad".',
  },
  {
    key: 'minSubstantiated',
    label: 'Substantiation floor',
    anchor: 'substantiation-floor',
    why: 'Below this an attestation contributes nothing at all. A claim with no support is not worth partial credit - it is worth nothing, and gets a bond slashed if it falls further.',
  },
  {
    key: 'minConfidence',
    label: 'Confidence floor',
    anchor: 'confidence-floor',
    why: "The model's certainty about its own reading. It gates rather than scales, so the score tracks evidence instead of hesitancy.",
  },
  {
    key: 'confidenceTol',
    label: 'Validator tolerance',
    anchor: 'validator-tolerance',
    why: 'Allowed spread between leader and validator on each graded field. Tight enough to catch disagreement, loose enough that two honest readings of the same prose still agree.',
  },
  {
    key: 'repeatShiftCap',
    label: 'Repeat damping cap',
    anchor: 'repeat-damping-cap',
    why: 'Largest damping shift, so weight cannot underflow to nothing from volume alone. A prolific but honest counterparty still counts for something.',
  },
  {
    key: 'minBond',
    label: 'First-attestation bond',
    anchor: 'first-attestation-bond',
    why: 'What it costs to attest once. Doubles on each repeat about the same subject, mirroring the halving in weight.',
  },
  {
    key: 'slashFloor',
    label: 'Slash floor',
    anchor: 'slash-floor',
    why: 'Below this the bond is slashed. Keyed on substantiation, never on sentiment - slashing negative reviews would turn the oracle into a praise machine.',
  },
  {
    key: 'releaseFloor',
    label: 'Release floor',
    anchor: 'release-floor',
    why: 'At or above this the bond comes back in full. Between the two floors it is returned but the attestation carries reduced weight.',
  },
  {
    key: 'bondLockSeconds',
    label: 'Bond lock',
    anchor: 'bond-lock',
    why: 'How long a releasable bond stays locked before reclaim, leaving room for a dispute to surface before the money leaves. The same window governs collateral that nobody ever graded.',
  },
  {
    key: 'collateralCeilingBp',
    label: 'Collateral ceiling',
    anchor: 'collateral-ceiling',
    why: 'What an agent with no record posts to take on work, as a share of the value of that work. Above 100% deliberately: an unknown counterparty is asked to put up more than the job is worth, because nothing else stands behind it.',
  },
  {
    key: 'collateralFloorBp',
    label: 'Collateral floor',
    anchor: 'collateral-floor',
    why: 'What the same work costs an agent with a perfect record. The distance between this and the ceiling is what a reputation is worth in working capital - and the floor being above zero is what stops a bought score converting into unlimited leverage.',
  },
  {
    key: 'collateralForfeitBp',
    label: 'Forfeit threshold',
    anchor: 'forfeit-threshold',
    why: 'Work graded below this is undelivered, and the collateral goes to the client. Only an attestation substantiated enough to carry weight in the score can trigger it, so an unevidenced accusation moves no money.',
  },
]
