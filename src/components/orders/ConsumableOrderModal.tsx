'use client'

import { useState, useEffect } from 'react'
import type { Consumable } from '@/types/order'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

type Selection = { consumableId: string; quantity: number }

export function ConsumableOrderModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [consumables, setConsumables] = useState<Consumable[]>([])
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [purposeFilter, setPurposeFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    fetch(`/api/consumables?facilityId=${facilityId}`)
      .then(r => r.json())
      .then(d => setConsumables(d.consumables ?? []))
      .catch(() => setError('消耗品の取得に失敗しました'))
  }, [isOpen, facilityId])

  const resetForm = () => {
    setSelections({})
    setPurposeFilter('')
    setError(null)
  }

  const handleClose = () => { resetForm(); onClose() }

  if (!isOpen) return null

  const purposes = Array.from(new Set(consumables.map(c => c.purpose)))
  const filtered = purposeFilter ? consumables.filter(c => c.purpose === purposeFilter) : consumables

  const toggle = (id: string) => {
    setSelections(prev => {
      if (prev[id]) { const next = { ...prev }; delete next[id]; return next }
      return { ...prev, [id]: 1 }
    })
  }

  const setQty = (id: string, qty: number) => setSelections(prev => ({ ...prev, [id]: qty }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const items: Selection[] = Object.entries(selections).map(([consumableId, quantity]) => ({ consumableId, quantity }))
    if (!items.length) { setError('発注物品を1つ以上選択してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/consumable-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId, items }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      resetForm()
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
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>消耗品発注</h2>
          <button type="button" onClick={handleClose} style={{ color: '#6B7280' }}>✕</button>
        </div>

        {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

        <div className="mb-4">
          <label className={labelClass} style={labelStyle}>用途で絞り込み</label>
          <select value={purposeFilter} onChange={e => setPurposeFilter(e.target.value)} className="border rounded px-3 py-2 text-sm w-full" style={{ borderColor: '#E5E7EB' }}>
            <option value="">すべて</option>
            {purposes.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4 border rounded divide-y" style={{ borderColor: '#E5E7EB' }}>
            {filtered.length === 0 && <p className="px-4 py-3 text-sm" style={{ color: '#6B7280' }}>消耗品が登録されていません</p>}
            {filtered.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <input type="checkbox" id={`c-${c.id}`} checked={!!selections[c.id]} onChange={() => toggle(c.id)} className="w-4 h-4" />
                <label htmlFor={`c-${c.id}`} className="flex-1 text-sm" style={{ color: '#111827' }}>
                  {c.name}
                  {c.jan && <span className="ml-2 text-xs" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{c.jan}</span>}
                  <span className="ml-2 text-xs px-1 rounded" style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}>{c.purpose}</span>
                </label>
                {selections[c.id] && (
                  <input type="number" min={1} value={selections[c.id]} onChange={e => setQty(c.id, Number(e.target.value))} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={handleClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#16A34A' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
