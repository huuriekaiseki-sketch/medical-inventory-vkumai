'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { LoanReturn } from '@/types/order'
import { formatJstDate, formatJstDateTime } from '@/lib/format-date'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  returned: '返却済',
  cancelled: '取り消し済',
}

export default function LoanReturnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [returns, setReturns] = useState<LoanReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/loan-returns?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { if (!cancelled) setReturns(d.returns ?? []) })
      .catch(() => { if (!cancelled) setError('一覧の取得に失敗しました') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [id])

  // WHY(E-056): 間違えて登録した返却を、製品の中で直せるようにする。
  //      **行は消さず取り消し状態にする**ので、一覧には「取り消し済」として残り、
  //      誰がいつ取り消したかは監査ログに残る。残数と未返却の件数からは除かれる。
  const handleCancel = async (ret: LoanReturn) => {
    if (!confirm('この返却を取り消しますか？（取り消すと元に戻せません）')) return
    setCancellingId(ret.id)
    setError(null)
    try {
      const res = await fetch(`/api/loan-returns/${ret.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId: id, action: 'cancel' }),
      })
      if (!res.ok) {
        const { error: message } = await res.json().catch(() => ({ error: '取り消しに失敗しました' }))
        setError(message ?? '取り消しに失敗しました')
        return
      }
      setReturns(prev => prev.map(r => (r.id === ret.id ? { ...r, status: 'cancelled' } : r)))
    } catch {
      setError('取り消しに失敗しました')
    } finally {
      setCancellingId(null)
    }
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
        <p className="text-sm" style={{ color: '#4B5563' }}>読み込み中...</p>
      ) : returns.length === 0 ? (
        <p className="text-sm" style={{ color: '#4B5563' }}>返却履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>返却日時</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(ret => (
                <tr key={ret.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {ret.returnDatetime ? formatJstDateTime(ret.returnDatetime) : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4B5563' }}>{STATUS_LABEL[ret.status] ?? ret.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {formatJstDate(ret.createdAt)}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {ret.status === 'cancelled' ? (
                      <span style={{ color: '#6B7280' }}>—</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCancel(ret)}
                        disabled={cancellingId === ret.id}
                        className="text-sm hover:underline disabled:opacity-50"
                        style={{ color: '#B91C1C' }}
                      >
                        {cancellingId === ret.id ? '取り消し中…' : '取り消す'}
                      </button>
                    )}
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
