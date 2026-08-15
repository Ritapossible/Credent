/**
 * React bindings for the chain reads.
 *
 * Deliberately small. There is no cache, no revalidation and no query library:
 * the registry is a handful of view calls, the pages that use it are entered by
 * navigation rather than polled, and a stale-while-revalidate layer would add a
 * second source of truth about what the chain currently says.
 *
 * What it does handle is the part that actually bites - a response arriving
 * after the component that asked for it has gone. Every effect below drops its
 * result if the inputs changed or the component unmounted first, so a fast
 * click through three agents cannot leave the third showing the first's score.
 */

import { useEffect, useState } from 'react'

import { type Policy } from '../core/policy'
import { IS_CONFIGURED } from './config'
import { loadAgent, loadRegistry, type AgentReport } from './registry'
import { getPolicy } from './oracle'

export interface Async<T> {
  data: T | null
  loading: boolean
  /** Null while loading or on success; the failure reason otherwise. */
  error: string | null
  /** True when no contract address was configured at build time. */
  unconfigured: boolean
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({
    data: null,
    loading: IS_CONFIGURED,
    error: null,
    unconfigured: !IS_CONFIGURED,
  })

  useEffect(() => {
    if (!IS_CONFIGURED) {
      setState({ data: null, loading: false, error: null, unconfigured: true })
      return
    }

    let live = true
    setState({ data: null, loading: true, error: null, unconfigured: false })

    run().then(
      (data) => {
        if (live) setState({ data, loading: false, error: null, unconfigured: false })
      },
      (cause) => {
        if (live) {
          setState({ data: null, loading: false, error: messageOf(cause), unconfigured: false })
        }
      },
    )

    return () => {
      live = false
    }
    // `run` is rebuilt every render by design; `deps` is what identifies the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

/**
 * The registry, under the parameters the contract actually deployed with.
 *
 * `policy` is left undefined by every caller in the app; it exists so a caller
 * that already holds the deployed policy can avoid re-reading it, not so a page
 * can substitute a different one. Passing the shipped constant here would make
 * the site explain its own defaults rather than the deployment in front of it.
 */
export function useRegistry(policy?: Policy): Async<AgentReport[]> {
  return useAsync(() => loadRegistry(policy), [policy])
}

export function useAgent(address: string, policy?: Policy): Async<AgentReport> {
  return useAsync(() => loadAgent(address, policy), [address, policy])
}

/** The deployed parameters on their own, for pages that quote them. */
export function useDeployedPolicy(): Async<Policy> {
  return useAsync(() => getPolicy(), [])
}
