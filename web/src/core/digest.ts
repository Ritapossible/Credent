/**
 * Port of the content-addressing half of `reputation_core.py`.
 *
 * The scope builder needs these to show the client the same digest the contract
 * will commit. A digest that disagrees with the chain is worse than no digest, so
 * the Python encoding is reproduced exactly rather than approximated.
 */

import { sha256Hex } from './sha256'

/**
 * Canonical comparison form for an address.
 *
 * Mirrors `normalize_address`. Python uses `str.casefold()`, which differs from
 * `toLowerCase()` on a handful of non-Latin characters (`ß` folds to `ss`). Every
 * value that reaches here is hex, where the two agree; the contract layer owns
 * real address validation.
 */
export function normalizeAddress(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.trim().toLowerCase()
}

/**
 * `json.dumps(text, ensure_ascii=True, separators=(",", ":"))` for a string.
 *
 * `JSON.stringify` gets the quoting and the control-character escapes right but
 * leaves non-ASCII literal, where `ensure_ascii=True` escapes it. Escaping per
 * UTF-16 code unit also reproduces Python's surrogate-pair spelling of astral
 * characters, so an emoji in a scope hashes identically on both sides.
 */
function pythonJsonString(text: string): string {
  return JSON.stringify(text).replace(
    /[-￿]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

/**
 * Content address of an engagement's scope.
 *
 * Committed when the engagement opens, before the outcome is known. This digest
 * is what proves the standard being graded against did not change afterwards.
 */
export function scopeDigest(scope: string): string {
  return sha256Hex(pythonJsonString(scope))
}

/**
 * Per-attestation fence salt for prompt construction.
 *
 * Derived from content rather than randomness so every validator builds a
 * byte-identical prompt, and unpredictable to the attester because it commits to
 * a scope digest they do not solely control.
 */
export function attestationSalt(input: {
  scope: string
  attester: string
  subject: string
  claim: string
}): string {
  const material = [
    scopeDigest(input.scope),
    normalizeAddress(input.attester),
    normalizeAddress(input.subject),
    input.claim,
  ].join('|')
  return sha256Hex(material)
}
