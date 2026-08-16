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

import { CREDENT_POLICY, type Policy } from '../core/policy'
import { readableError } from '../core/errors'
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
          setState({
            data: null,
            loading: false,
            error: readableError(cause),
            unconfigured: false,
          })
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

/**
 * The policy a page should quote, and whether it came from the chain.
 *
 * Every page that puts a parameter in front of a visitor has to answer the same
 * question - deployed value or shipped constant - and answering it per page is
 * how five of them ended up quoting `CREDENT_POLICY` as though it were
 * deployed. The live deployment ran with `minBond: 0`, so a page rendering the
 * constant told visitors an attestation cost a bond nobody was ever charged,
 * and the whole attack-cost argument rested on it.
 *
 * `live` is the part callers must not ignore. `CREDENT_POLICY` is a reasonable
 * thing to draw while the read is in flight - it is this repo's intended
 * configuration - but a page that shows it without saying so is making the same
 * claim again, quietly. Pages label it.
 */
export function useEffectivePolicy(): { policy: Policy; live: boolean; error: string | null } {
  const { data, error } = useDeployedPolicy()
  return {
    policy: data ?? CREDENT_POLICY,
    live: data !== null,
    error,
  }
}
