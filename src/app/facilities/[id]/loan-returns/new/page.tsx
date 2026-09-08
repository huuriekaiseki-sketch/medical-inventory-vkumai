'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ItemRowInput, type ItemRow } from '@/components/orders/ItemRowInput'
import { jstLocalInputToIso } from '@/lib/format-date'
import type { LoanOrder, OrderListItem } from '@/types/order'

/** 対象の短貸発注を選んだときに出す行（発注明細 1 つにつき 1 行） */
type OrderLine = {
  itemId: string
  name: string
  jan: string
  /** まだ返っていない数量 */
  remaining: number
  /** これから返す数量。0 なら送らない */
  returning: number
  lot: string
  ubd: string
}

export default function NewLoanReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [returnDatetime, setReturnDatetime] = useState('')
  const [freeItems, setFreeItems] = useState<ItemRow[]>(() => [{ id: crypto.randomUUID(), jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loanOrderId, setLoanOrderId] = useState('')
  const [unreturnedLoanOrders, setUnreturnedLoanOrders] = useState<OrderListItem[]>([])
  const [orderLines, setOrderLines] = useState<OrderLine[]>([])
  const [linesLoading, setLinesLoading] = useState(false)
  // WHY: 二重送信対策の鍵（P-053）。ページを開いたときに 1 回だけ作り、再送でも同じ鍵を送る
  const [clientRequestId] = useState(() => crypto.randomUUID())

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

  // WHY(2026-09-08): 分割返却を表せるようにしたので、対象の短貸発注を選んだら
  //      **その明細と残数**を出して行ごとに返す数量を入れられるようにする。
  //      残数はここで計算せず、発注の明細と紐付いた返却の合計から出す（一覧と同じ数え方）。
  // WHY(選択を外したときの掃除は onChange 側でやる): effect の中で同期的に setState すると
  //      連鎖レンダーになる（react-hooks/set-state-in-effect）。**利用者の操作で消える**方が
  //      React としても素直なので、選択を変えた時点で行を空にしてから読み直す。
  useEffect(() => {
    if (!loanOrderId) return
    let cancelled = false
    async function loadLines() {
      setLinesLoading(true)
      try {
        const res = await fetch(`/api/loan-orders?facility_id=${id}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        const order = ((data.orders ?? []) as LoanOrder[]).find(o => o.id === loanOrderId)
        const lines: OrderLine[] = (order?.items ?? []).map(item => {
          const returned = (item.returnedQuantity ?? 0)
          return {
            itemId: item.id,
            name: item.name,
            jan: item.jan ?? '',
            remaining: Math.max(item.quantity - returned, 0),
            returning: 0,
            lot: '',
            ubd: '',
          }
        })
        setOrderLines(lines.filter(l => l.remaining > 0))
      } catch {
        if (!cancelled) setOrderLines([])
      } finally {
        if (!cancelled) setLinesLoading(false)
      }
    }
    loadLines()
    return () => {
      cancelled = true
    }
  }, [id, loanOrderId])

  const updateLine = (itemId: string, field: 'returning' | 'lot' | 'ubd', value: string | number) =>
    setOrderLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, [field]: value } : l)))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      // 対象を選んでいるときは明細ごとの行を、選んでいないときは従来の自由入力を送る
      const items = loanOrderId
        ? orderLines
            .filter(l => l.returning > 0)
            .map(l => ({
              jan: l.jan,
              lot: l.lot || undefined,
              ubd: l.ubd || undefined,
              quantity: l.returning,
              loanOrderItemId: l.itemId,
            }))
        : freeItems.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity }))

      if (loanOrderId && items.length === 0) {
        setError('返す数量を 1 つ以上入力してください')
        return
      }

      const res = await fetch('/api/loan-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          returnDatetime: jstLocalInputToIso(returnDatetime),
          items,
          ...(loanOrderId ? { loanOrderId } : {}),
          clientRequestId,
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
            onChange={e => {
              setLoanOrderId(e.target.value)
              setOrderLines([])
            }}
            className="border rounded px-3 py-2 text-sm w-full"
            style={{ borderColor: '#E5E7EB' }}
          >
            <option value="">選択しない</option>
            {unreturnedLoanOrders.map(order => (
              <option key={order.id} value={order.id}>{order.summary}</option>
            ))}
          </select>
        </div>

        {loanOrderId ? (
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>返却物品（残っているものだけ出ます）</p>
            {linesLoading ? (
              <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
            ) : orderLines.length === 0 ? (
              <p className="text-sm" style={{ color: '#6B7280' }}>返す物が残っていません。</p>
            ) : (
              <div>
                <div className="flex gap-2 mb-1 px-1">
                  <span className="text-xs font-semibold flex-1" style={{ color: '#6B7280' }}>品名</span>
                  <span className="text-xs font-semibold w-16" style={{ color: '#6B7280' }}>残り</span>
                  <span className="text-xs font-semibold w-20" style={{ color: '#6B7280' }}>返す数</span>
                  <span className="text-xs font-semibold w-24" style={{ color: '#6B7280' }}>LOT</span>
                  <span className="text-xs font-semibold w-24" style={{ color: '#6B7280' }}>UBD</span>
                </div>
                {orderLines.map(line => (
                  <div key={line.itemId} className="flex gap-2 mb-2 items-center">
                    <span className="text-sm flex-1" style={{ color: '#111827' }}>{line.name}</span>
                    <span className="text-sm w-16" style={{ color: '#6B7280' }}>{line.remaining}</span>
                    <input
                      type="number"
                      aria-label={`${line.name} の返す数`}
                      value={line.returning}
                      onChange={e => updateLine(line.itemId, 'returning', Math.min(Number(e.target.value) || 0, line.remaining))}
                      min={0}
                      max={line.remaining}
                      className="border rounded px-2 py-1 text-sm w-20"
                      style={{ borderColor: '#E5E7EB' }}
                    />
                    <input
                      type="text"
                      aria-label={`${line.name} の LOT`}
                      value={line.lot}
                      onChange={e => updateLine(line.itemId, 'lot', e.target.value)}
                      placeholder="LOT"
                      className="border rounded px-2 py-1 text-sm w-24"
                      style={{ borderColor: '#E5E7EB' }}
                    />
                    <input
                      type="text"
                      aria-label={`${line.name} の UBD`}
                      value={line.ubd}
                      onChange={e => updateLine(line.itemId, 'ubd', e.target.value)}
                      placeholder="UBD"
                      className="border rounded px-2 py-1 text-sm w-24"
                      style={{ borderColor: '#E5E7EB' }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>返却物品</p>
            <ItemRowInput rows={freeItems} onChange={setFreeItems} />
          </div>
        )}

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
