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

function readNetwork(): NetworkAlias {
  const raw = import.meta.env.VITE_GENLAYER_NETWORK?.trim()
  if (!raw) return DEFAULT_NETWORK
  if (raw in CHAINS) return raw as NetworkAlias
  // A typo here would otherwise fall back to studionet and read an address that
  // does not exist on it, which surfaces as an empty registry rather than a
  // misconfiguration. Fail where the mistake is.
  throw new Error(
    `VITE_GENLAYER_NETWORK="${raw}" is not a known network. ` +
      `Expected one of: ${Object.keys(CHAINS).join(', ')}.`,
  )
}

export const NETWORK: NetworkAlias = readNetwork()

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

export const IS_CONFIGURED = isDeployed(CONTRACT_ADDRESS)

/** Where a transaction or address can be inspected, for links in the UI. */
export const EXPLORER_URL = CHAIN.blockExplorers?.default?.url ?? ''
