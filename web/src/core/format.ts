/**
 * Presentation helpers.
 *
 * Kept apart from `core/` proper: everything here is about how a number reads,
 * and none of it may feed back into a value the chain would verify.
 */

import { BP } from './policy'

/** Basis points as a percentage string. 7500 → "75.0%". */
export function bpToPercent(bp: number, digits = 1): string {
  return `${(bp / (BP / 100)).toFixed(digits)}%`
}

/** Basis points on the 0-100 score scale Credent shows agents on. 7500 → "75.0". */
export function bpToScore(bp: number, digits = 1): string {
  return (bp / (BP / 100)).toFixed(digits)
}

const USDC_DECIMALS = 6n

/**
 * Token base units as a decimal string.
 *
 * Integer division on `bigint` throughout - a bond at 18 decimals exceeds
 * `Number.MAX_SAFE_INTEGER`, so converting to a float to format it would misquote
 * what an attester has to post.
 */
export function formatUnits(value: bigint, decimals = USDC_DECIMALS): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const scale = 10n ** decimals
  const whole = magnitude / scale
  const fraction = magnitude % scale

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (fraction === 0n) return `${negative ? '-' : ''}${groupedWhole}`

  const fractionText = fraction.toString().padStart(Number(decimals), '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${groupedWhole}.${fractionText}`
}

/** A bond amount with its unit, for prose and labels. */
export function formatBond(value: bigint): string {
  return `${formatUnits(value)} USDC`
}

/** Whole seconds as the coarsest unit that stays honest. */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '-'
  if (seconds < 60) return `${seconds}s`

  const units: Array<[number, string]> = [
    [31_536_000, 'y'],
    [2_592_000, 'mo'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ]

  for (const [size, suffix] of units) {
    if (seconds >= size) {
      const value = seconds / size
      const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
      return `${rounded}${suffix}`
    }
  }
  return `${seconds}s`
}

/** Middle-truncated address for tight columns. Full value belongs in a title. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address
  return `${address.slice(0, lead)}…${address.slice(-tail)}`
}

/** Digest, shown as its two ends. Digests are compared, not read. */
export function shortDigest(digest: string): string {
  if (digest.length <= 16) return digest
  return `${digest.slice(0, 8)}…${digest.slice(-8)}`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** Score band, for the meter fill and the label beside it. */
export type ScoreBand = 'strong' | 'fair' | 'thin' | 'poor'

export function scoreBand(scoreBp: number): ScoreBand {
  if (scoreBp >= 7500) return 'strong'
  if (scoreBp >= 6000) return 'fair'
  if (scoreBp >= 4000) return 'thin'
  return 'poor'
}

export const BAND_LABEL: Record<ScoreBand, string> = {
  strong: 'Strong',
  fair: 'Fair',
  thin: 'Thin',
  poor: 'Poor',
}
