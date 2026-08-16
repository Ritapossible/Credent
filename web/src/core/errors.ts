/**
 * Turning a thrown thing into a line a visitor can act on.
 *
 * Errors here arrive from three layers with three different ideas of an
 * audience: the contract names a reason it rejected a call, this app throws
 * sentences it wrote itself, and viem throws a formatted block with a headline,
 * a `Details:` line, a docs path and its own version number. The last one was
 * reaching the page verbatim - `Requested resource not found.` followed by
 * `Version: viem@2.55.13` - which tells a user nothing and looks like a crash
 * report.
 *
 * The rule is: keep the most specific sentence available, drop the machinery.
 * Nothing is invented and nothing is swallowed; a message this cannot improve
 * is returned as it came, because a wrong guess about what went wrong is worse
 * than a technical string.
 */

/** Headlines viem emits that say nothing on their own; its `Details:` line does. */
const GENERIC = [
  'an unknown rpc error occurred.',
  'requested resource not found.',
  'missing or invalid parameters.',
  'an internal error was received.',
  'execution reverted.',
]

/** Lines that are machinery rather than message. */
function isNoise(line: string): boolean {
  return (
    line.startsWith('Version: ') ||
    line.startsWith('docsPath') ||
    line.startsWith('URL: ') ||
    line.startsWith('Request body: ') ||
    line.startsWith('at ') ||
    line.startsWith('Raw Call Arguments') ||
    line === ''
  )
}

export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  return String(cause)
}

/**
 * The sentence to show, given anything that was thrown.
 *
 * `Details:` wins over the headline when the headline is one of viem's generic
 * ones, because that is where the real cause lives - a rate limit, a missing
 * transaction, a contract that does not exist at the address.
 */
export function readableError(cause: unknown): string {
  const lines = messageOf(cause)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isNoise(line))

  if (lines.length === 0) return 'Something went wrong.'

  const detail = lines.find((line) => line.startsWith('Details: '))?.slice('Details: '.length)
  const headline = lines[0]

  const chosen =
    detail && GENERIC.includes(headline.toLowerCase()) ? detail : (headline ?? detail ?? '')

  // Long enough to carry a contract reason, short enough not to become a wall.
  return chosen.length > 300 ? `${chosen.slice(0, 297)}…` : chosen
}

/**
 * Whether this is the public RPC refusing to answer for a while.
 *
 * Worth naming, because it is the one failure a visitor can resolve by simply
 * waiting, and the registry walks enough calls per load to provoke it.
 */
export function isRateLimit(cause: unknown): boolean {
  return /rate limit/i.test(messageOf(cause))
}
