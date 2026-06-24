'use client'

export type ItemRow = {
  jan: string
  lot: string
  ubd: string
  quantity: number
}

type Props = {
  rows: ItemRow[]
  onChange: (rows: ItemRow[]) => void
}

export function ItemRowInput({ rows, onChange }: Props) {
  const addRow = () => onChange([...rows, { jan: '', lot: '', ubd: '', quantity: 1 }])
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: keyof ItemRow, value: string | number) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  return (
    <div>
      <div className="flex gap-2 mb-1 px-1">
        <span className="text-xs font-semibold w-36" style={{ color: '#6B7280' }}>JAN</span>
        <span className="text-xs font-semibold w-28" style={{ color: '#6B7280' }}>LOT</span>
        <span className="text-xs font-semibold w-24" style={{ color: '#6B7280' }}>UBD</span>
        <span className="text-xs font-semibold w-16" style={{ color: '#6B7280' }}>数量</span>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 mb-2 items-center">
          <input
            type="text"
            value={row.jan}
            onChange={e => updateRow(i, 'jan', e.target.value)}
            placeholder="JAN"
            className="border rounded px-2 py-1 text-sm w-36"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="text"
            value={row.lot}
            onChange={e => updateRow(i, 'lot', e.target.value)}
            placeholder="LOT"
            className="border rounded px-2 py-1 text-sm w-28"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="text"
            value={row.ubd}
            onChange={e => updateRow(i, 'ubd', e.target.value)}
            placeholder="UBD"
            className="border rounded px-2 py-1 text-sm w-24"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="number"
            value={row.quantity}
            onChange={e => updateRow(i, 'quantity', Number(e.target.value))}
            min={1}
            className="border rounded px-2 py-1 text-sm w-16"
            style={{ borderColor: '#E5E7EB' }}
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            className="text-sm px-2 py-1"
            style={{ color: '#DC2626' }}
          >
            削除
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-sm px-3 py-1 rounded border"
        style={{ borderColor: '#072C2C', color: '#072C2C' }}
      >
        + 行を追加
      </button>
    </div>
  )
}
