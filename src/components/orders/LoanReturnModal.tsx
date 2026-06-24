'use client'

import { useState } from 'react'
import { ItemRowInput, type ItemRow } from './ItemRowInput'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function LoanReturnModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [returnDatetime, setReturnDatetime] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          returnDatetime,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>短貸返却</h2>
          <button type="button" onClick={onClose} style={{ color: '#6B7280' }}>✕</button>
        </div>
        {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="returnDatetime" className={labelClass} style={labelStyle}>返却日時 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="returnDatetime" type="datetime-local" value={returnDatetime} onChange={e => setReturnDatetime(e.target.value)} required className="border rounded px-3 py-2 text-sm w-full" style={{ borderColor: '#E5E7EB' }} />
          </div>
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>返却物品</p>
            <ItemRowInput rows={items} onChange={setItems} />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#4B5563' }}>
              {submitting ? '送信中...' : '返却する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
