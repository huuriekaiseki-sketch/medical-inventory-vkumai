'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type LoanItemRow = { jan: string; name: string; quantity: number }

export default function NewLoanOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [procedureName, setProcedureName] = useState('')
  const [maker, setMaker] = useState('')
  const [items, setItems] = useState<LoanItemRow[]>([{ jan: '', name: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRow = () => setItems(prev => [...prev, { jan: '', name: '', quantity: 1 }])
  const removeRow = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: keyof LoanItemRow, value: string | number) =>
    setItems(prev => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!procedureName.trim()) { setError('手技名を入力してください'); return }
    if (!maker.trim()) { setError('メーカーを入力してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          procedureName,
          maker,
          items: items.map(r => ({ jan: r.jan || undefined, name: r.name, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/loan-orders`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
  const inputClass = 'border rounded px-3 py-2 text-sm w-full'
  const inputStyle = { borderColor: '#E5E7EB' }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/loan-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 短貸発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#2563EB', fontFamily: 'var(--font-oswald), sans-serif' }}>New Loan Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          短貸発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="maker" className={labelClass} style={labelStyle}>メーカー <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="maker" type="text" value={maker} onChange={e => setMaker(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-6">
          <p className={labelClass} style={labelStyle}>発注物品</p>
          <div className="flex gap-2 mb-1 px-1">
            <span className="text-xs font-semibold w-28" style={{ color: '#6B7280' }}>JAN（任意）</span>
            <span className="text-xs font-semibold flex-1" style={{ color: '#6B7280' }}>品名</span>
            <span className="text-xs font-semibold w-16" style={{ color: '#6B7280' }}>数量</span>
          </div>
          {items.map((row, i) => (
            <div key={i} className="flex gap-2 mb-2 items-center">
              <input type="text" value={row.jan} onChange={e => updateRow(i, 'jan', e.target.value)} placeholder="JAN" className="border rounded px-2 py-1 text-sm w-28" style={{ borderColor: '#E5E7EB' }} />
              <input type="text" value={row.name} onChange={e => updateRow(i, 'name', e.target.value)} placeholder="品名" className="border rounded px-2 py-1 text-sm flex-1" style={{ borderColor: '#E5E7EB' }} />
              <input type="number" value={row.quantity} onChange={e => updateRow(i, 'quantity', Number(e.target.value) || 0)} min={1} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
              <button type="button" onClick={() => removeRow(i)} className="text-sm px-2" style={{ color: '#DC2626' }}>削除</button>
            </div>
          ))}
          <button type="button" onClick={addRow} className="text-sm px-3 py-1 rounded border" style={{ borderColor: '#072C2C', color: '#072C2C' }}>+ 行を追加</button>
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/loan-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#2563EB' }}>
            {submitting ? '送信中...' : '発注する'}
          </button>
        </div>
      </form>
    </div>
  )
}
