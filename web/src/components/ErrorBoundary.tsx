/**
 * The last line of defence against a blank page.
 *
 * Without one, a single exception thrown during render unmounts the whole tree
 * and React leaves an empty document behind - no masthead, no navigation, no
 * indication anything happened. That is the worst failure this site can have,
 * because it is indistinguishable from a broken deployment and gives the visitor
 * nowhere to go.
 *
 * It has to be a class: `componentDidCatch` and `getDerivedStateFromError` have
 * no hook equivalent, and this is the one component in the app that needs them.
 *
 * Two are mounted. The outer one wraps everything and catches a failure in the
 * chrome itself; the inner one wraps only the routed page and is keyed by path,
 * so a page that throws leaves the masthead intact and navigating away clears
 * it. Neither is a substitute for handling a known failure where it happens -
 * chain reads report their own errors through `ChainState`, which is a state
 * rather than an exception.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { readableError } from '../core/errors'

interface Props {
  children: ReactNode
  /** Distinguishes the whole-site boundary from the per-page one in the copy. */
  scope?: 'site' | 'page'
}

interface State {
  message: string | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(cause: unknown): State {
    return { message: readableError(cause) }
  }

  componentDidCatch(cause: Error, info: ErrorInfo): void {
    // Kept: the boundary shows a sentence, and the console keeps the stack that
    // sentence was reduced from. Losing it would make this harder to debug than
    // the crash it replaces.
    console.error('[credent] render failed', cause, info.componentStack)
  }

  private reset = () => {
    this.setState({ message: null })
  }

  render(): ReactNode {
    const { message } = this.state
    if (message === null) return this.props.children

    return (
      <div className="shell page">
        <div className="notice notice--critical">
          <h1 className="notice__title">
            {this.props.scope === 'site' ? 'Credent failed to load' : 'This page failed to render'}
          </h1>
          <p>{message}</p>
          <p className="muted">
            This is a bug in the site rather than a problem with the chain. The scores themselves
            are on-chain and unaffected.
          </p>
          <button type="button" className="btn" onClick={this.reset}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}
