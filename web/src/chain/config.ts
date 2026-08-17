/**
 * Where the UI reads the chain from.
 *
 * Both values come from the build environment rather than a checked-in constant.
 * The contract address changes every time it is redeployed, and a redeploy that
 * needs a source edit is a redeploy someone eventually does wrong; the network
 * changes when the same build is pointed at localnet to debug something.
 *
 * `VITE_` is not a prefix choice - Vite only exposes variables carrying it to the
 * client bundle, and anything here is public by construction. Nothing secret can
 * live in this file, which is the point: a contract address is not a credential,
 * and the site never holds a key.
 */

import { localnet, studionet, testnetAsimov, testnetBradbury } from 'genlayer-js/chains'
import type { GenLayerChain } from 'genlayer-js/types'

import { NATIVE_DECIMALS, NATIVE_SYMBOL } from '../core/format'

/** The networks a build may target, by the alias the GenLayer CLI uses. */
const CHAINS = {
  localnet,
  studionet,
  'testnet-asimov': testnetAsimov,
  'testnet-bradbury': testnetBradbury,
} as const

export type NetworkAlias = keyof typeof CHAINS

const DEFAULT_NETWORK: NetworkAlias = 'studionet'

/**
 * Resolve the target network, reporting a bad value instead of throwing.
 *
 * A typo must not be allowed to silently fall back to studionet and read an
 * address that does not exist there, which would surface as an empty registry
 * rather than as a misconfiguration - so an unknown alias still stops the site
 * from reading anything, through `IS_CONFIGURED` below.
 *
 * What it must not do is throw. This runs while the module is being evaluated,
 * before React exists, so an exception here takes the whole bundle down and
 * leaves a blank document that no error boundary can catch - the one failure
 * mode indistinguishable from a broken deployment. A typo in a Vercel
 * environment variable is a routine mistake and deserves a rendered message,
 * not a white screen.
 */
function readNetwork(): { network: NetworkAlias; error: string | null } {
  const raw = import.meta.env.VITE_GENLAYER_NETWORK?.trim()
  if (!raw) return { network: DEFAULT_NETWORK, error: null }
  if (raw in CHAINS) return { network: raw as NetworkAlias, error: null }
  return {
    network: DEFAULT_NETWORK,
    error:
      `VITE_GENLAYER_NETWORK="${raw}" is not a known network. ` +
      `Expected one of: ${Object.keys(CHAINS).join(', ')}.`,
  }
}

const resolved = readNetwork()

/**
 * The chain still denominates bonds the way `core/format` assumes.
 *
 * `core/` holds the token's decimals and symbol as constants so it stays
 * independent of this module and keeps running under plain Node for the parity
 * script. That independence is only safe while the two agree, and the cost of
 * them disagreeing is every bond figure on the site being wrong by a power of
 * ten - which is exactly the defect this replaced. So it is checked once, here,
 * against the chain definition the client is built from.
 */
function checkDenomination(chain: GenLayerChain): string | null {
  const native = chain.nativeCurrency
  if (native.decimals === Number(NATIVE_DECIMALS) && native.symbol === NATIVE_SYMBOL) {
    return null
  }
  return (
    `${chain.name} denominates value in ${native.symbol} at ${native.decimals} decimals, ` +
    `but this build formats bonds as ${NATIVE_SYMBOL} at ${NATIVE_DECIMALS}. ` +
    `Every bond figure would be wrong, so nothing is read.`
  )
}

export const NETWORK: NetworkAlias = resolved.network

/**
 * Why the build's configuration cannot be used, if it cannot be. Null normally.
 * Rendered by `ChainState` and by a banner in the layout; nothing reads the
 * chain while it is set.
 */
export const CONFIG_ERROR: string | null =
  resolved.error ?? checkDenomination(CHAINS[resolved.network])

export const CHAIN: GenLayerChain = CHAINS[NETWORK]

/**
 * The deployed `ReputationOracle`.
 *
 * Empty when the site is built without one. That is a legitimate state - the
 * contract is deployed after the frontend exists at least once - so it is
 * reported to the user as unconfigured rather than thrown at module load.
 */
export const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS?.trim() ??
  '') as `0x${string}` | ''

/** A 20-byte hex address, which is the only shape `readContract` accepts. */
export function isDeployed(
  address: string,
): address is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

/**
 * Whether this build can read the chain at all.
 *
 * False when the network alias was rejected, not only when the address is
 * missing: reading a studionet address because the alias was misspelled is the
 * silent wrong answer this is here to prevent.
 */
export const IS_CONFIGURED = CONFIG_ERROR === null && isDeployed(CONTRACT_ADDRESS)

/**
 * Where a transaction or address can be inspected, for links in the UI.
 *
 * Studionet is overridden. The SDK's chain definition points at
 * `genlayer-explorer.vercel.app`, which is not where studionet transactions are
 * browsable, so every "view transaction" link on the site went to a page that
 * could not find the hash. The other networks carry explorers that do resolve, so
 * only this one is corrected.
 *
 * The host is `explorer-studio.genlayer.com`. This previously read
 * `genlayer-studio.genlayer.com`, which does not resolve at all - it fails at
 * DNS, so the override replaced a page that could not find the hash with a page
 * that could not be reached. `explorer-studio.genlayer.com` serves the GenLayer
 * Studio Explorer and answers `/tx/<hash>` and `/address/<address>`, which are
 * the two shapes linked from here, `Docs.tsx` and `ConnectButton.tsx`.
 */
const EXPLORER_OVERRIDE: Partial<Record<NetworkAlias, string>> = {
  studionet: 'https://explorer-studio.genlayer.com',
}

export const EXPLORER_URL =
  EXPLORER_OVERRIDE[NETWORK] ?? CHAIN.blockExplorers?.default?.url ?? ''
