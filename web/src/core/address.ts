/**
 * Is this a 20-byte hex address?
 *
 * The codebase had no such check. `normalizeAddress` lowercases and trims and
 * returns a string for any input, so a page that validated with
 * `normalizeAddress(x) !== null` validated nothing: the expression is always
 * true, the error hint never rendered, and the submit button enabled on any
 * text. `addressArg` caught it before a transaction went out, so the cost was a
 * confusing failure rather than lost gas -- but the guard was decorative.
 *
 * `0X…` is accepted along with `0x…`: it is a shape addresses genuinely arrive
 * in when pasted, and rejecting it produced an error about a string that
 * plainly was an address.
 */
export function isAddress(text: unknown): boolean {
  return typeof text === 'string' && /^0[xX][0-9a-fA-F]{40}$/.test(text.trim())
}
