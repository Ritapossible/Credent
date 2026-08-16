/**
 * The write client.
 *
 * Everything that sends a transaction. It is a separate module from `client.ts`
 * on purpose: the read client holds no account and cannot be made to sign, so
 * the registry loads for a visitor who has never connected a wallet, and nothing
 * on the read path can spend by accident. Writing is opt-in and starts here.
 *
 * The site still never holds a key. Every transaction below is signed by the
 * visitor's own wallet through `window.ethereum` - the page passes an address
 * and a provider, never a secret - which is why nothing in the deployment
 * configuration is sensitive.
 *
 * ## Why not `client.connect()`
 *
 * The SDK ships a `connect()` that switches the wallet's network for you, and
 * this module does that by hand instead. `connect()` also installs the GenLayer
 * MetaMask *Snap* (`wallet_requestSnaps`), which is a MetaMask-only dependency
 * and a second install prompt for the visitor - and nothing here needs it.
 * Writes go out as an ordinary `eth_sendTransaction` to the consensus contract,
 * which any injected EIP-1193 wallet can sign. So the chain switch is done with
 * the two standard calls (EIP-3085 / EIP-3326) and the snap never comes up.
 */

import { createClient } from 'genlayer-js'
import { TransactionStatus } from 'genlayer-js/types'
import type { GenLayerTransaction } from 'genlayer-js/types'

import { CHAIN, CONTRACT_ADDRESS, IS_CONFIGURED } from './config'
import { addressArg } from './oracle'

/**
 * The slice of EIP-1193 this module uses.
 *
 * Declared here rather than imported: the SDK's `ClientConfig.provider` is typed
 * as an `EthereumProvider` it does not export, and `any` on the one object that
 * moves money is not a trade worth making.
 */
export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, handler: (...args: never[]) => void): void
  removeListener?(event: string, handler: (...args: never[]) => void): void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

export function getProvider(): EthereumProvider | null {
  return typeof window !== 'undefined' && window.ethereum ? window.ethereum : null
}

export function hasWallet(): boolean {
  return getProvider() !== null
}

const CHAIN_ID_HEX = `0x${CHAIN.id.toString(16)}`

// --- connection -----------------------------------------------------------

function asAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The connected account, without prompting.
 *
 * `eth_accounts` answers with what the visitor has already authorised for this
 * origin and shows no dialog, so it is safe to call on mount. `eth_requestAccounts`
 * is the one that opens the wallet, and it only runs from `connectWallet` - a
 * page that popped MetaMask because someone navigated to it would be a bug.
 */
export async function currentAccount(): Promise<string | null> {
  const provider = getProvider()
  if (!provider) return null
  try {
    const accounts = asAddresses(await provider.request({ method: 'eth_accounts' }))
    return accounts[0]?.toLowerCase() ?? null
  } catch {
    // A wallet that refuses to answer this is one we have no account for.
    return null
  }
}

/**
 * Put the wallet on the network this build reads from.
 *
 * Switch first and add only if the wallet does not know the chain: 4902 is the
 * "unrecognised chain" code, and adding a chain the visitor already has
 * configured would ask them to approve a duplicate. Studionet is not a chain any
 * wallet ships with, so the add path is the common one on a first connect.
 */
async function ensureChain(provider: EthereumProvider): Promise<void> {
  const current = await provider.request({ method: 'eth_chainId' })
  if (typeof current === 'string' && current.toLowerCase() === CHAIN_ID_HEX.toLowerCase()) {
    return
  }

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }],
    })
  } catch (cause) {
    const code = (cause as { code?: number })?.code
    if (code !== 4902) throw cause

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: CHAIN.name,
          rpcUrls: [...CHAIN.rpcUrls.default.http],
          nativeCurrency: CHAIN.nativeCurrency,
          ...(CHAIN.blockExplorers?.default?.url
            ? { blockExplorerUrls: [CHAIN.blockExplorers.default.url] }
            : {}),
        },
      ],
    })
  }
}

/** Prompt for access, then put the wallet on the right chain. Returns the address. */
export async function connectWallet(): Promise<string> {
  const provider = getProvider()
  if (!provider) {
    throw new Error(
      'No wallet found. Install MetaMask, or another EIP-1193 wallet, to post to the chain.',
    )
  }

  const accounts = asAddresses(await provider.request({ method: 'eth_requestAccounts' }))
  const address = accounts[0]
  if (!address) throw new Error('The wallet returned no accounts.')

  await ensureChain(provider)
  return address.toLowerCase()
}

/**
 * Subscribe to the two events that invalidate a connection.
 *
 * Both matter: an account switch changes who the next transaction is *from*, and
 * a chain switch points the wallet at a network where this contract does not
 * exist. Returns an unsubscribe, and is a no-op on providers that do not
 * implement the event surface.
 */
export function watchWallet(handlers: {
  onAccounts?: (address: string | null) => void
  onChain?: (chainId: string) => void
}): () => void {
  const provider = getProvider()
  if (!provider?.on) return () => {}

  const onAccounts = (...args: never[]) => {
    const accounts = asAddresses(args[0])
    handlers.onAccounts?.(accounts[0]?.toLowerCase() ?? null)
  }
  const onChain = (...args: never[]) => {
    if (typeof args[0] === 'string') handlers.onChain?.(args[0])
  }

  provider.on('accountsChanged', onAccounts)
  provider.on('chainChanged', onChain)

  return () => {
    provider.removeListener?.('accountsChanged', onAccounts)
    provider.removeListener?.('chainChanged', onChain)
  }
}

/** Whether the wallet is currently pointed at the network this build reads. */
export async function onExpectedChain(): Promise<boolean> {
  const provider = getProvider()
  if (!provider) return false
  const current = await provider.request({ method: 'eth_chainId' })
  return typeof current === 'string' && current.toLowerCase() === CHAIN_ID_HEX.toLowerCase()
}

// --- sending --------------------------------------------------------------

function writeClient(account: string) {
  return createClient({
    chain: CHAIN,
    account: account as `0x${string}`,
    provider: getProvider() ?? undefined,
  })
}

export interface WriteResult {
  /** The GenLayer transaction id, which is what the explorer indexes. */
  hash: string
  /** The contract's return value as the node rendered it, when it returned one. */
  returned: string | null
}

interface Outcome {
  /** False when the contract rejected the call, however the node spelled it. */
  ok: boolean
  /** The contract's rejection reason, when it rejected and named one. */
  reason: string | null
  /** The leader's rendered return value, when the call returned one. */
  returned: string | null
}

/**
 * What the network decided actually happened, read from the leader's receipt.
 *
 * The outcome lives in `consensus_data.leader_receipt`, not at the top level.
 * Studio receipts carry `execution_result` there as `SUCCESS` or `ERROR`, beside
 * a `result` of `{ status: 'return', payload: { readable } }` when the call
 * returned and `{ status: 'contract_error', payload: '<reason>' }` when it did
 * not. The typed top-level `txExecutionResultName` this used to test is left
 * undefined on this network, so a check against it silently passed everything -
 * which is the same mistake in a new place, since a rejected write would then
 * have been reported to the visitor as a success.
 *
 * Both spellings of the enum are accepted because the SDK's own type
 * (`FINISHED_WITH_RETURN` / `FINISHED_WITH_ERROR`) is what other networks return,
 * and a receipt that carries neither is treated as a success only if nothing
 * else contradicts it - the node has to say a call failed for this to raise, and
 * an unrecognised shape must not invent a failure that did not happen.
 */
function outcomeOf(receipt: GenLayerTransaction): Outcome {
  const entries = receipt.consensus_data?.leader_receipt
  const list = Array.isArray(entries) ? entries : []

  // By `mode`, not by position. The array can carry more than one entry when a
  // round rotates, and the leader is whichever entry says it is - reading
  // `[0]` happened to be right on every receipt observed but is an assumption
  // about ordering that nothing documents. Falling back to the first entry
  // keeps the previous behaviour for a node that omits `mode` rather than
  // treating a missing field as a failure.
  const leader =
    list.find((entry) => (entry as { mode?: unknown })?.mode === 'leader') ?? list[0]

  const executed = (leader as { execution_result?: unknown })?.execution_result
  const result = (leader as { result?: unknown })?.result
  const status = (result as { status?: unknown })?.status
  const payload = (result as { payload?: unknown })?.payload

  const failed =
    executed === 'ERROR' ||
    executed === 'FINISHED_WITH_ERROR' ||
    receipt.txExecutionResultName === 'FINISHED_WITH_ERROR' ||
    (typeof status === 'string' && status !== 'return')

  const readable = (payload as { readable?: unknown })?.readable
  const message = (payload as { message?: unknown })?.message

  return {
    ok: !failed,
    reason:
      typeof payload === 'string' && payload.length > 0
        ? payload
        : typeof message === 'string' && message.length > 0
          ? message
          : typeof status === 'string' && status !== 'return'
            ? status
            : null,
    returned: typeof readable === 'string' ? readable : null,
  }
}

/**
 * Send one call and wait for the network to decide it.
 *
 * The outcome check is the point of this function. A GenLayer transaction can
 * reach `ACCEPTED` - consensus agreed on what happened - while what happened is
 * that the contract rejected the call. Treating the accepted status as success
 * is exactly the trap the first deployment of this contract fell into: the CLI
 * reported "deployed successfully" for a contract that had failed to load,
 * because it reported on the transaction rather than on the execution. So
 * acceptance is necessary here and not sufficient, and a failed execution is
 * raised with the contract's own reason code - `no_such_engagement`,
 * `already_attested`, `bond_below_required` and the rest are far more useful to
 * show than "execution failed".
 */
async function submit(
  account: string,
  functionName: string,
  args: unknown[],
  value = 0n,
): Promise<WriteResult> {
  if (!IS_CONFIGURED) {
    throw new Error(
      'No contract address configured. Set VITE_CONTRACT_ADDRESS to the deployed ' +
        'ReputationOracle before building.',
    )
  }

  const client = writeClient(account)
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName,
    args: args as never[],
    value,
  })

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
  })

  const outcome = outcomeOf(receipt)
  if (!outcome.ok) {
    throw new Error(
      outcome.reason
        ? `${functionName} was rejected by the contract: ${outcome.reason}`
        : `${functionName} was rejected by the contract.`,
    )
  }

  return { hash: String(hash), returned: outcome.returned }
}

// --- writes ---------------------------------------------------------------

/**
 * Commit a scope before the work starts. The sender becomes the client.
 *
 * `provider` goes through the shared address encoder rather than as a string;
 * see `addressArg` for what passing the hex text would do here.
 */
export function openEngagement(
  account: string,
  input: { engagementId: string; provider: string; scope: string },
): Promise<WriteResult> {
  return submit(account, 'open_engagement', [
    input.engagementId,
    addressArg(input.provider, 'open_engagement.provider'),
    input.scope,
  ])
}

/**
 * Agree to be graded on a scope someone proposed for you. Provider only.
 *
 * The consent step. An engagement names a provider who never asked to be named,
 * so until they accept it is a proposal and nothing about it can reach a score -
 * which is what stops attestation being usable against a stranger.
 */
export function acceptEngagement(account: string, engagementId: string): Promise<WriteResult> {
  return submit(account, 'accept_engagement', [engagementId])
}

/** Mark the work finished, which is what opens attestation. Either counterparty. */
export function closeEngagement(account: string, engagementId: string): Promise<WriteResult> {
  return submit(account, 'close_engagement', [engagementId])
}

/**
 * Grade one counterparty's account of a closed engagement.
 *
 * `bond` is the transaction's value and the contract checks it before it pays
 * the model to read anything, so an underfunded call is rejected rather than
 * graded. Callers should take the amount from `bondForNext`, which is what the
 * contract will require of *this* attester about *this* subject - it rises with
 * repetition, so a constant would be wrong on the second attestation.
 */
export function attest(
  account: string,
  input: { engagementId: string; claim: string; evidence: string; bond: bigint },
): Promise<WriteResult> {
  return submit(
    account,
    'attest',
    [input.engagementId, input.claim, input.evidence],
    input.bond,
  )
}

/** Return a releasable bond once its lock has elapsed. Attester only. */
export function reclaimBond(account: string, attestationId: number): Promise<WriteResult> {
  return submit(account, 'reclaim_bond', [attestationId])
}
