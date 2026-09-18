'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { Consumable, ConsumableOrder, ConsumablesApiGetResponse } from '@/types/order'
import { ConsumableRegisterForm } from '@/components/orders/ConsumableRegisterForm'
import { ConsumableList } from '@/components/orders/ConsumableList'
import { useFacilityRole } from '@/hooks/useFacilityRole'
import { formatJstDate } from '@/lib/format-date'

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
  // WHY(2026-09-09): 直す・止める・消すボタンは書ける人にだけ出す。viewer に押せないボタンを
  //      見せると「触れるが何も起きない道」になる（E-055 / C-032 と同じ形）。
  //      登録フォームも同じ理由でここに合わせた（以前は誰にでも出ていた）
  const { canWrite } = useFacilityRole(id)

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
    // WHY(includeRetired=1): ここは消耗品を管理する画面なので、止めたものも見える必要がある
    //      （発注の画面は既定＝active だけを引く）
    fetch(`/api/consumables?facilityId=${id}&includeRetired=1`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<ConsumablesApiGetResponse> })
      .then(d => { if (!cancelled) { setConsumables(d.consumables ?? []); setConsumablesError(null) } })
      .catch(() => { if (!cancelled) setConsumablesError('消耗品一覧の取得に失敗しました') })
    return () => {
      cancelled = true
    }
  }

  useEffect(() => {
    return fetchConsumables()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchConsumables は useCallback で包んでいないので毎レンダーで別物になる。依存に入れると取得が止まらない。読み直すきっかけは施設 ID だけでよい
  }, [id])

  const handleRegistered = () => {
    fetchConsumables()
  }

  const labelStyle = { color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#4B5563' }}>
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

      {canWrite && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest mb-3" style={labelStyle}>消耗品を登録</h2>
          <ConsumableRegisterForm facilityId={id} onRegistered={handleRegistered} />
        </div>
      )}

      <div className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest mb-3" style={labelStyle}>登録済みの消耗品</h2>
        {consumablesError && (
          <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{consumablesError}</div>
        )}
        {!consumablesError && (
          <ConsumableList
            facilityId={id}
            consumables={consumables}
            canWrite={canWrite}
            onChanged={handleRegistered}
          />
        )}
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: '#4B5563' }}>読み込み中...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm" style={{ color: '#4B5563' }}>発注履歴がありません。</p>
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
                  <td className="px-6 py-4 text-sm" style={{ color: '#4B5563' }}>{STATUS_LABEL[order.status] ?? order.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {formatJstDate(order.createdAt)}
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
