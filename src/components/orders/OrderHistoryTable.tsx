'use client'

import type { OrderKind, OrderListItem } from '@/types/order'

// WHY: issue #20 Part 2 Set E「ステータスラベルマップ」をそのまま踏襲。
// 既存値（draft/submitted/returned）以外は想定外だが、フォールバックで生値を表示し画面を壊さない。
const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
  returned: '返却済',
}

// WHY: 施設別ページ（OrderButtons.tsx）の種別カラーを踏襲し、種別バッジの見た目を一覧全体で統一する。
const KIND_LABEL: Record<OrderKind, string> = {
  case_order: '症例発注',
  consumable_order: '消耗品発注',
  loan_order: '短貸発注',
  loan_return: '短貸返却',
}

const KIND_COLOR: Record<OrderKind, string> = {
  case_order: '#FF5F03',
  consumable_order: '#16A34A',
  loan_order: '#2563EB',
  loan_return: '#4B5563',
}

type Props = {
  items: OrderListItem[]
}

const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

export function OrderHistoryTable({ items }: Props) {
  return (
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
                <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#6B7280' }}>
                  {STATUS_LABEL[item.status] ?? item.status}
                  {item.unreturned && (
                    <span
                      className="ml-2 px-2 py-1 rounded text-xs font-semibold text-white"
                      style={{ backgroundColor: '#DC2626' }}
                    >
                      未返却
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                  {new Date(item.createdAt).toLocaleDateString('ja-JP')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
