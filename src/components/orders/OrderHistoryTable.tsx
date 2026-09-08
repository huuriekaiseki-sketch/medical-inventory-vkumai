'use client'

import { useState } from 'react'
import type { OrderKind, OrderListItem } from '@/types/order'
import { formatJstDate } from '@/lib/format-date'

// WHY: issue #20 Part 2 Set E「ステータスラベルマップ」をそのまま踏襲。
// 既存値（draft/submitted/returned）以外は想定外だが、フォールバックで生値を表示し画面を壊さない。
const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
  returned: '返却済',
  cancelled: '取り消し済',
}

/**
 * 発注の種別 → 取り消しを受ける API（E-056）。
 * `loan_return` は返却の一覧側で取り消す（この表からは出さない）。
 */
const CANCEL_ENDPOINT: Partial<Record<OrderKind, string>> = {
  case_order: '/api/case-orders',
  consumable_order: '/api/consumable-orders',
  loan_order: '/api/loan-orders',
}

// WHY: 施設別ページ（OrderButtons.tsx）の種別カラーを踏襲し、種別バッジの見た目を一覧全体で統一する。
const KIND_LABEL: Record<OrderKind, string> = {
  case_order: '症例発注',
  consumable_order: '消耗品発注',
  loan_order: '短貸発注',
  loan_return: '短貸返却',
}

const KIND_COLOR: Record<OrderKind, string> = {
  case_order: '#B03F00',
  consumable_order: '#16A34A',
  loan_order: '#2563EB',
  loan_return: '#4B5563',
}

type Props = {
  items: OrderListItem[]
  /**
   * 取り消しを出すかどうか。施設が決まっている一覧でだけ出す（E-056）。
   * 取り消しは施設 ID を要求するので、横断の一覧（施設未指定）では出せない。
   */
  facilityId?: string
  /** 取り消しが通ったときに呼ぶ。呼び出し側が一覧を更新する */
  onCancelled?: (id: string) => void
}

const labelStyle = { color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }

export function OrderHistoryTable({ items, facilityId, onCancelled }: Props) {
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // WHY(E-056): 間違えて登録した発注を、製品の中で直せるようにする。
  //      **行は消さず取り消し状態にする**ので一覧に「取り消し済」として残り、
  //      短貸なら未返却から、症例・消耗品なら発注金額の集計から外れる。
  const handleCancel = async (item: OrderListItem) => {
    const endpoint = CANCEL_ENDPOINT[item.kind]
    if (!endpoint || !facilityId) return
    if (!confirm('この発注を取り消しますか？（取り消すと元に戻せません）')) return
    setCancellingId(item.id)
    setError(null)
    try {
      const res = await fetch(`${endpoint}/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId, action: 'cancel' }),
      })
      if (!res.ok) {
        const { error: message } = await res.json().catch(() => ({ error: '取り消しに失敗しました' }))
        setError(message ?? '取り消しに失敗しました')
        return
      }
      onCancelled?.(item.id)
    } catch {
      setError('取り消しに失敗しました')
    } finally {
      setCancellingId(null)
    }
  }

  const showActions = Boolean(facilityId)

  return (
    <div>
      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" role="alert" style={{ backgroundColor: '#DC2626' }}>
          {error}
        </div>
      )}
    <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
      {/* WHY: モバイル幅(375px)でも列が崩れず内容を確認できるよう、テーブルだけを水平スクロール対象にする */}
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>種別</th>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>概要</th>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>ステータス</th>
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>作成日</th>
              {showActions && (
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>操作</th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                <td className="px-6 py-4 text-sm whitespace-nowrap">
                  <span
                    className="px-2 py-1 rounded text-xs font-semibold text-white"
                    style={{ backgroundColor: KIND_COLOR[item.kind] }}
                  >
                    {KIND_LABEL[item.kind]}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>{item.summary}</td>
                <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#4B5563' }}>
                  {STATUS_LABEL[item.status] ?? item.status}
                  {item.unreturned && (
                    <span
                      className="ml-2 px-2 py-1 rounded text-xs font-semibold text-white"
                      style={{ backgroundColor: '#DC2626' }}
                    >
                      {/* WHY(残数を出す・2026-09-08): 分割返却を表せるようにしたので、
                          「未返却」だけだと一部返した発注と 1 本も返していない発注が同じに見える。
                          残数が取れないとき（古い応答・紐付けの無い発注）は数を出さずバッジだけ出す */}
                      {item.outstandingQuantity ? `未返却 ${item.outstandingQuantity}` : '未返却'}
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                  {formatJstDate(item.createdAt)}
                </td>
                {showActions && (
                  <td className="px-6 py-4 text-sm whitespace-nowrap">
                    {item.status === 'cancelled' || !CANCEL_ENDPOINT[item.kind] ? (
                      <span style={{ color: '#6B7280' }}>—</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCancel(item)}
                        disabled={cancellingId === item.id}
                        className="text-sm hover:underline disabled:opacity-50"
                        style={{ color: '#B91C1C' }}
                      >
                        {cancellingId === item.id ? '取り消し中…' : '取り消す'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  )
}
