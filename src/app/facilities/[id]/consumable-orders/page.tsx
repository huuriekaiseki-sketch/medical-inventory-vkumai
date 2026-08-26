'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { Consumable, ConsumableOrder, ConsumablesApiGetResponse } from '@/types/order'
import { ConsumableRegisterForm } from '@/components/orders/ConsumableRegisterForm'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
}

export default function ConsumableOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [orders, setOrders] = useState<ConsumableOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [consumables, setConsumables] = useState<Consumable[]>([])
  const [consumablesError, setConsumablesError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/consumable-orders?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { if (!cancelled) setOrders(d.orders ?? []) })
      .catch(() => { if (!cancelled) setError('一覧の取得に失敗しました') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [id])

  // 消耗品一覧はサーバー側で purpose 昇順に整列されているため、登録後の
  // 反映も並び順を崩さないようここから再取得する(handleRegisteredで直接
  // 末尾追加すると新規分だけソート順が崩れるため)。
  const fetchConsumables = () => {
    let cancelled = false
    fetch(`/api/consumables?facilityId=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<ConsumablesApiGetResponse> })
      .then(d => { if (!cancelled) { setConsumables(d.consumables ?? []); setConsumablesError(null) } })
      .catch(() => { if (!cancelled) setConsumablesError('消耗品一覧の取得に失敗しました') })
    return () => {
      cancelled = true
    }
  }

  useEffect(() => {
    return fetchConsumables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleRegistered = (_consumable: Consumable) => {
    fetchConsumables()
  }

  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="flex items-end justify-between mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#16A34A' }}>Consumable Orders</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            消耗品発注
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/consumable-orders/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#16A34A' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      <div className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest mb-3" style={labelStyle}>消耗品を登録</h2>
        <ConsumableRegisterForm facilityId={id} onRegistered={handleRegistered} />
      </div>

      <div className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest mb-3" style={labelStyle}>登録済みの消耗品</h2>
        {consumablesError && (
          <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{consumablesError}</div>
        )}
        {!consumablesError && consumables.length === 0 ? (
          <p className="text-sm" style={{ color: '#6B7280' }}>消耗品が登録されていません。</p>
        ) : !consumablesError ? (
          <ul className="rounded bg-white shadow-sm divide-y" style={{ border: '1px solid #E5E7EB' }}>
            {consumables.map(c => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 text-sm" style={{ color: '#111827' }}>
                {c.name}
                {c.jan && <span className="text-xs" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{c.jan}</span>}
                <span className="text-xs px-1 rounded" style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}>{c.purpose}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>発注履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[order.status] ?? order.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(order.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
