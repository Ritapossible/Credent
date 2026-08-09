interface Props {
  label: string
  value: string
  note?: string
}

/**
 * Label, value, note. A headline number is a tile, not a one-bar chart.
 *
 * The value uses the font's proportional figures: `tabular-nums` gives every digit
 * the width of a zero, which reads loose at display sizes. Tabular figures are for
 * columns that must align vertically, and those live in the tables.
 */
export default function StatTile({ label, value, note }: Props) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {note ? <span className="stat__note muted">{note}</span> : null}
    </div>
  )
}
