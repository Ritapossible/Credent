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

export const NETWORK: NetworkAlias = resolved.network

/**
 * Why the build's configuration cannot be used, if it cannot be. Null normally.
 * Rendered by `ChainState` and by a banner in the layout; nothing reads the
 * chain while it is set.
 */
export const CONFIG_ERROR: string | null = resolved.error

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

/** Where a transaction or address can be inspected, for links in the UI. */
export const EXPLORER_URL = CHAIN.blockExplorers?.default?.url ?? ''
