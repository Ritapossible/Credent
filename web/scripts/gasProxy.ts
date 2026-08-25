/**
 * A local JSON-RPC shim that corrects the target network's gas estimates.
 *
 * Asimov's `eth_estimateGas` under-reports GenLayer consensus calls, and
 * genlayer-js hands the estimate straight to the signer with no buffer, so every
 * deploy and every write reverts. Measured rather than inferred: a deploy
 * reverted having consumed 1,966,511 of a 2,090,330 limit - which is exactly
 * what `eth_estimateGas` returned for it - while replaying the identical call
 * through `eth_call` at 20,000,000 succeeded. A 1,002-byte contract failed the
 * same way as the 96,285-byte one, so this is not about contract size.
 *
 * ## Why a proxy rather than a gas argument
 *
 * There is no gas argument to pass. `deployContract` accepts only
 * `code`/`args`/`kwargs`/`leaderOnly`/`consensusMaxRotations`, and the estimate
 * is taken privately inside `_sendTransaction`.
 *
 * Overriding `estimateTransactionGas` on the client does not work either, and
 * that was tried first: `createClient` assembles its result by spreading
 * successive snapshots, so `deployContract` closes over an *earlier* object than
 * the one returned to the caller. Patching the returned client left the gas
 * limit at 2.1M and the transaction reverted exactly as before.
 *
 * What the SDK's transport does re-read on every single request is
 * `chainConfig.rpcUrls.default.http[0]`, and `createClient` accepts an
 * `endpoint` that sets it. Correcting the number in front of the SDK therefore
 * catches deploys, writes and consensus calls alike, with no reliance on the
 * shape of any internal object.
 *
 * ## What it does and does not touch
 *
 * Only `eth_estimateGas` responses. Everything else is forwarded byte for byte,
 * so this cannot change what a transaction *does* - only how much room it is
 * given to do it in. Raising a gas limit costs nothing when unused: gas is
 * charged for what is consumed, and only the limit times the price has to be
 * affordable up front, which at asimov's prices is a fraction of a GEN.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'

export interface GasProxy {
  /** Pass to `createClient({ endpoint })`. */
  url: string
  close: () => Promise<void>
}

export interface GasProxyOptions {
  /** Multiplier applied to a successful estimate. */
  multiplier?: bigint
  /** Never send less than this, however small the estimate. */
  floor?: bigint
  /**
   * What to answer when the node refuses to estimate at all.
   *
   * The large contract answers `BlockPubdataLimitReached` rather than a number,
   * and bradbury answers a bare `null`. Left alone, the SDK catches either and
   * falls back to a 200,000 default, which is two orders of magnitude short and
   * is rejected as `intrinsic gas too low`. Answering generously instead lets
   * the node itself decide whether the transaction fits.
   *
   * Generously, but *not* limitlessly - see `cap`. This was 100,000,000, which
   * is precisely bradbury's block gas limit, so the deploy asked for an entire
   * block and was silently dropped from the mempool: no receipt, no rejection,
   * no transaction to look up, just a ten-minute wait ending in a timeout. The
   * measured consumption of this contract is about 2,000,000.
   */
  onEstimateFailure?: bigint
  /**
   * A hard limit on any answer, whatever the arithmetic above produces.
   *
   * A gas limit at or near the block limit is not a safe over-estimate - it is
   * unminable, and it fails in the worst possible way, by looking like a network
   * that is ignoring you. This keeps both the multiplied estimate and the
   * fallback comfortably inside a block so the node can actually schedule the
   * transaction.
   */
  cap?: bigint
}

/**
 * The estimate as a number, or null if the node did not give us one.
 *
 * Parsing is allowed to fail here. A gas estimate that cannot be read is not an
 * error worth propagating - the caller's answer to "no usable estimate" is the
 * same ceiling either way - and letting `BigInt` throw inside the request
 * handler is what turned a soft failure into a dead deploy once already.
 */
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const min = (a: bigint, b: bigint) => (a < b ? a : b)

function usableEstimate(raw: unknown): bigint | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

export function startGasProxy(
  upstream: string,
  options: GasProxyOptions = {},
): Promise<GasProxy> {
  const multiplier = options.multiplier ?? 5n
  const floor = options.floor ?? 20_000_000n
  const onFailure = options.onEstimateFailure ?? 20_000_000n
  const cap = options.cap ?? 30_000_000n

  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      void (async () => {
        let parsed: { method?: string; id?: unknown } | null = null
        try {
          parsed = JSON.parse(body) as { method?: string; id?: unknown }
        } catch {
          parsed = null
        }

        const reply = (payload: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(payload))
        }

        try {
          const upstreamResponse = await fetch(upstream, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(60_000),
          })
          const data = (await upstreamResponse.json()) as {
            result?: unknown
            error?: unknown
          }

          if (parsed?.method === 'eth_estimateGas') {
            // `null` is a *third* answer, distinct from a number and from an
            // error, and it is what bradbury returns rather than estimating.
            // This previously read `data.result !== undefined`, which null
            // passes - so the success branch ran `BigInt(null)`, threw
            // `Cannot convert null to a BigInt`, and the catch below reported it
            // as a transport failure. The ceiling was unreachable for exactly
            // the case it exists to cover, and the SDK fell back to its own
            // 200,000 default, which the node then rejected as
            // `intrinsic gas too low`.
            //
            // So the shape of the answer decides nothing on its own: what
            // matters is whether a usable number came back. Anything else -
            // absent, null, an error, or a string that will not parse - takes
            // the ceiling and lets the node judge the transaction on its merits.
            const raised = usableEstimate(data.result)
            const wanted = raised === null ? onFailure : max(raised * multiplier, floor)
            if (raised === null) delete data.error
            data.result = `0x${min(wanted, cap).toString(16)}`
          }
          reply(data)
        } catch (cause) {
          reply({
            jsonrpc: '2.0',
            id: parsed?.id ?? 1,
            error: { code: -32000, message: String((cause as Error)?.message ?? cause) },
          })
        }
      })()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}
