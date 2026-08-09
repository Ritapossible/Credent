import { useId, useMemo, useState } from 'react'

export interface Series {
  key: string
  label: string
  /** CSS custom property name for the mark color, e.g. `--series-1`. */
  color: string
  points: Array<{ x: number; y: number }>
}

interface Props {
  series: Series[]
  xLabel: string
  yLabel: string
  formatX: (value: number) => string
  formatY: (value: number) => string
  /** Optional horizontal rule, for a threshold or ceiling. */
  marker?: { y: number; label: string }
  height?: number
}

const PAD = { top: 16, right: 18, bottom: 40, left: 60 }
const VIEW_W = 720
const Y_TICKS = 5
const X_TICKS = 5

/**
 * Line chart with a hover crosshair.
 *
 * An SVG chart on a page is interactive by default, so the crosshair and tooltip
 * ship rather than being an enhancement: the tooltip supplements the axis and the
 * table view, it never gates a value. Nearest-x hit testing over one transparent
 * overlay rect keeps the hit target the full column height instead of the 2px
 * line.
 */
export default function LineChart({
  series,
  xLabel,
  yLabel,
  formatX,
  formatY,
  marker,
  height = 300,
}: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const clipId = useId()

  const plotW = VIEW_W - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom

  const domain = useMemo(() => {
    const all = series.flatMap((s) => s.points)
    const xs = all.map((p) => p.x)
    const ys = all.map((p) => p.y)
    if (marker) ys.push(marker.y)
    const yMax = Math.max(1, ...ys)
    return {
      xMin: Math.min(...xs),
      xMax: Math.max(...xs),
      yMin: 0,
      // Round the top of the scale up to a clean number so ticks land on readable values.
      yMax: niceCeil(yMax, Y_TICKS),
    }
  }, [series, marker])

  const sx = (x: number) =>
    PAD.left +
    (domain.xMax === domain.xMin ? 0 : ((x - domain.xMin) / (domain.xMax - domain.xMin)) * plotW)
  const sy = (y: number) => PAD.top + plotH - (y / domain.yMax) * plotH

  const yTicks = useMemo(() => ticksFor(domain.yMax, Y_TICKS), [domain.yMax])
  const primary = series[0]
  const xTickIndexes = useMemo(() => {
    if (!primary) return []
    const last = primary.points.length - 1
    if (last <= 0) return [0]
    // Interpolate the tick positions across the whole run rather than stepping by a
    // fixed stride and appending the end: a stride that does not divide evenly leaves
    // a final label a few pixels from its neighbour, and the two overprint.
    const out: number[] = []
    for (let i = 0; i <= X_TICKS; i += 1) {
      const index = Math.round((last * i) / X_TICKS)
      if (out[out.length - 1] !== index) out.push(index)
    }
    return out
  }, [primary])

  if (!primary) return null

  const active = hoverIndex === null ? null : primary.points[hoverIndex]

  return (
    <div className="chart">
      {series.length > 1 ? (
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key} className="legend__item">
              <span className="legend__key" style={{ background: `var(${s.color})` }} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="chart__plot">
        <svg
          viewBox={`0 0 ${VIEW_W} ${height}`}
          className="chart__svg"
          role="img"
          aria-label={`${yLabel} against ${xLabel}`}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={sy(tick)}
                y2={sy(tick)}
                stroke="var(--grid)"
                strokeWidth="1"
              />
              <text x={PAD.left - 10} y={sy(tick) + 4} className="chart__tick" textAnchor="end">
                {formatY(tick)}
              </text>
            </g>
          ))}

          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={PAD.top + plotH}
            y2={PAD.top + plotH}
            stroke="var(--rule-strong)"
            strokeWidth="1"
          />

          {xTickIndexes.map((index) => {
            const point = primary.points[index]
            if (!point) return null
            return (
              <text
                key={index}
                x={sx(point.x)}
                y={PAD.top + plotH + 22}
                className="chart__tick"
                textAnchor="middle"
              >
                {formatX(point.x)}
              </text>
            )
          })}

          {marker ? (
            <g clipPath={`url(#${clipId})`}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={sy(marker.y)}
                y2={sy(marker.y)}
                stroke="var(--ink-muted)"
                strokeWidth="1"
              />
              <text
                x={PAD.left + plotW - 4}
                y={sy(marker.y) - 8}
                className="chart__tick"
                textAnchor="end"
              >
                {marker.label}
              </text>
            </g>
          ) : null}

          {hoverIndex !== null && active ? (
            <line
              x1={sx(active.x)}
              x2={sx(active.x)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--rule-strong)"
              strokeWidth="1"
            />
          ) : null}

          <g clipPath={`url(#${clipId})`}>
            {series.map((s) => (
              <path
                key={s.key}
                d={pathFor(s.points, sx, sy)}
                fill="none"
                stroke={`var(${s.color})`}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </g>

          {hoverIndex !== null
            ? series.map((s) => {
                const point = s.points[hoverIndex]
                if (!point) return null
                return (
                  <circle
                    key={s.key}
                    cx={sx(point.x)}
                    cy={sy(point.y)}
                    r="4.5"
                    fill={`var(${s.color})`}
                    stroke="var(--surface-1)"
                    strokeWidth="2"
                  />
                )
              })
            : null}

          <text
            x={PAD.left + plotW / 2}
            y={height - 4}
            className="chart__axis-title"
            textAnchor="middle"
          >
            {xLabel}
          </text>

          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={(event) => {
              const svg = event.currentTarget.ownerSVGElement
              if (!svg) return
              const rect = svg.getBoundingClientRect()
              const ratio = (event.clientX - rect.left) / rect.width
              const xInView = ratio * VIEW_W
              setHoverIndex(nearestIndex(primary.points, xInView, sx))
            }}
            onMouseLeave={() => setHoverIndex(null)}
          />
        </svg>

        {hoverIndex !== null && active ? (
          <div
            className="tooltip"
            style={{
              left: `${(sx(active.x) / VIEW_W) * 100}%`,
              top: `${(sy(Math.max(...series.map((s) => s.points[hoverIndex]?.y ?? 0))) / height) * 100}%`,
            }}
            role="status"
          >
            <div className="tooltip__head">
              {xLabel}: {formatX(active.x)}
            </div>
            {series.map((s) => {
              const point = s.points[hoverIndex]
              if (!point) return null
              return (
                <div key={s.key} className="tooltip__row">
                  <span className="legend__key" style={{ background: `var(${s.color})` }} />
                  <span className="tooltip__label">{s.label}</span>
                  <span className="tooltip__value">{formatY(point.y)}</span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function pathFor(
  points: Array<{ x: number; y: number }>,
  sx: (x: number) => number,
  sy: (y: number) => number,
): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ')
}

function nearestIndex(
  points: Array<{ x: number; y: number }>,
  xInView: number,
  sx: (x: number) => number,
): number {
  let best = 0
  let bestDistance = Infinity
  points.forEach((point, index) => {
    const distance = Math.abs(sx(point.x) - xInView)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

/**
 * Round a scale top up to a clean multiple of the tick count, so every tick lands on
 * a readable value without stranding the series in the bottom half of the plot. The
 * step is snapped to 1/2/2.5/5 × a power of ten — the coarse 1/2/5 alternative turns
 * a 115M series into a 200M axis, which reads as headroom that is not there.
 */
function niceCeil(value: number, ticks: number): number {
  if (value <= 0) return 1
  const rough = value / ticks
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return step * magnitude * ticks
}

function ticksFor(max: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i)
}
