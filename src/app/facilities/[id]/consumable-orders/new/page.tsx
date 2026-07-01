'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Consumable } from '@/types/order'

export default function NewConsumableOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const TABS = ['ALL', 'PCI', 'EVT', 'デバイス', 'ABL'] as const
  type Tab = typeof TABS[number]

  const [consumables, setConsumables] = useState<Consumable[]>([])
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [activeTab, setActiveTab] = useState<Tab>('ALL')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/consumables?facilityId=${id}`)
      .then(r => r.json())
      .then(d => setConsumables(d.consumables ?? []))
      .catch(() => setError('消耗品の取得に失敗しました'))
  }, [id])

  const filtered = activeTab === 'ALL' ? consumables : consumables.filter(c => c.purpose === activeTab)

  const toggle = (consumableId: string) => {
    setSelections(prev => {
      if (prev[consumableId]) { const next = { ...prev }; delete next[consumableId]; return next }
      return { ...prev, [consumableId]: 1 }
    })
  }

  const setQty = (consumableId: string, qty: number) => setSelections(prev => ({ ...prev, [consumableId]: qty }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const items = Object.entries(selections).map(([consumableId, quantity]) => ({ consumableId, quantity }))
    if (!items.length) { setError('発注物品を1つ以上選択してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/consumable-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId: id, items }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/consumable-orders`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/consumable-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 消耗品発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#16A34A', fontFamily: 'var(--font-oswald), sans-serif' }}>New Consumable Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          消耗品発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <div className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label className={labelClass} style={labelStyle}>用途で絞り込み</label>
          <div className="flex gap-2 flex-wrap">
            {TABS.map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className="px-4 py-1.5 text-sm font-semibold rounded-full border transition-colors"
                style={activeTab === tab
                  ? { backgroundColor: '#16A34A', color: '#fff', borderColor: '#16A34A' }
                  : { backgroundColor: '#fff', color: '#6B7280', borderColor: '#E5E7EB' }}
              >
                {tab}
              </button>
            ))}
          </div>
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
                  <input type="number" min={1} value={selections[c.id]} onChange={e => setQty(c.id, Number(e.target.value) || 1)} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <Link href={`/facilities/${id}/consumable-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
              キャンセル
            </Link>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#16A34A' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
