import type { CSSProperties } from 'react'

/**
 * Inline style feeding `--range-fill` to `.range` in `base.css`.
 *
 * Styling a range's track takes the filled portion away from the browser, and
 * CSS has no way to read an input's value back - so the percentage has to come
 * from the render that already knows it.
 */
export function rangeFill(value: number, min: number, max: number): CSSProperties {
  const span = max - min
  const pct = span <= 0 ? 0 : ((value - min) / span) * 100
  return { '--range-fill': `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties
}
