'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { LoanReturn } from '@/types/order'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  returned: '返却済',
}

export default function LoanReturnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [returns, setReturns] = useState<LoanReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/loan-returns?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => setReturns(d.returns ?? []))
      .catch(() => setError('一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

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
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#4B5563' }}>Loan Returns</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            短貸返却
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/loan-returns/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#4B5563' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : returns.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>返却履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>返却日時</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(ret => (
                <tr key={ret.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {ret.returnDatetime ? new Date(ret.returnDatetime).toLocaleString('ja-JP') : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[ret.status] ?? ret.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(ret.createdAt).toLocaleDateString('ja-JP')}
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
