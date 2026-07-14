'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ItemRowInput, type ItemRow } from '@/components/orders/ItemRowInput'
import type { OrderListItem } from '@/types/order'

export default function NewLoanReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [returnDatetime, setReturnDatetime] = useState('')
  const [items, setItems] = useState<ItemRow[]>(() => [{ id: crypto.randomUUID(), jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loanOrderId, setLoanOrderId] = useState('')
  const [unreturnedLoanOrders, setUnreturnedLoanOrders] = useState<OrderListItem[]>([])

  // WHY: 「未返却」バッジ判定（loan_returns.loan_order_id、issue #20 Set A）は返却作成時に
  //      対象の短貸発注を紐付けない限り、その短貸発注は永久に未返却のまま表示され続けるバグに
  //      なる（レビュー指摘: critical。書き込み経路が配線されていなかった）。
  //      返却フォームから対象の短貸発注（未返却のもの）を選べるようにする
  useEffect(() => {
    let cancelled = false
    async function loadUnreturnedLoanOrders() {
      try {
        const res = await fetch(`/api/orders?facility_id=${id}&kind=loan_order`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const orders = (data.orders ?? []) as OrderListItem[]
        setUnreturnedLoanOrders(orders.filter(o => o.unreturned))
      } catch {
        // WHY: 対象選択肢の取得失敗は致命的ではない（対象を選ばずに返却自体は可能）ため、
        //      フォームの利用を止めずにエラーを握りつぶす
      }
    }
    loadUnreturnedLoanOrders()
    return () => {
      cancelled = true
    }
  }, [id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          returnDatetime,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
          ...(loanOrderId ? { loanOrderId } : {}),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/loan-returns`)
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
        <Link href={`/facilities/${id}/loan-returns`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 短貸返却一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }}>New Loan Return</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          短貸返却
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="returnDatetime" className={labelClass} style={labelStyle}>返却日時 <span style={{ color: '#DC2626' }}>*</span></label>
          <input
            id="returnDatetime"
            type="datetime-local"
            value={returnDatetime}
            onChange={e => setReturnDatetime(e.target.value)}
            required
            className="border rounded px-3 py-2 text-sm w-full"
            style={{ borderColor: '#E5E7EB' }}
          />
        </div>
        <div className="mb-4">
          <label htmlFor="loanOrderId" className={labelClass} style={labelStyle}>対象の短貸発注（任意）</label>
          <select
            id="loanOrderId"
            value={loanOrderId}
            onChange={e => setLoanOrderId(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-full"
            style={{ borderColor: '#E5E7EB' }}
          >
            <option value="">選択しない</option>
            {unreturnedLoanOrders.map(order => (
              <option key={order.id} value={order.id}>{order.summary}</option>
            ))}
          </select>
        </div>
        <div className="mb-6">
          <p className={labelClass} style={labelStyle}>返却物品</p>
          <ItemRowInput rows={items} onChange={setItems} />
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/loan-returns`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#4B5563' }}>
            {submitting ? '送信中...' : '返却する'}
          </button>
        </div>
      </form>
    </div>
  )
}
