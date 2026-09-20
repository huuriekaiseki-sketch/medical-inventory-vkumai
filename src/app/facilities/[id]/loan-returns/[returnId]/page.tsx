'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { LoanReturn, LoanReturnDetailApiResponse } from '@/types/order'
import { formatJstDateTime } from '@/lib/format-date'

// WHY(issue #809 レビュー指摘: 型安全・データ層の整合 important): `Record<string, string>` だと
//      status に新しい値が増えてもコンパイラが「ラベルの登録漏れ」を検知できない
//      （case-orders/[orderId]/page.tsx と同じ理由。SPEC.md が指摘した既存バグの再発防止）。
const STATUS_LABEL: Record<LoanReturn['status'], string> = {
  draft: '下書き',
  returned: '返却済',
  cancelled: '取り消し済',
}

const GENERIC_ERROR_MESSAGE = '返却の取得に失敗しました'

type ViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'done'; loanReturn: LoanReturn }

/**
 * 短貸返却の詳細（issue #809）。読み取り専用。
 *
 * WHY(取り消しの示し方): 取り消しは「その記録は誤りだった」の意味。回ごと(status)・
 *      明細ごと(items[].status)のどちらも消さず文字で示し、明細が取り消し済みなら
 *      「実際には返却されていない可能性があります」を添える（ロット検索(lot-search/page.tsx)と同じ文言）。
 * WHY(見つからない扱い・facilityId突き合わせ): case-orders の詳細ページと同じ理由
 *      （src/app/facilities/[id]/case-orders/[orderId]/page.tsx 参照）。
 */
export default function LoanReturnDetailPage({
  params,
}: {
  params: Promise<{ id: string; returnId: string }>
}) {
  const { id, returnId } = use(params)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/loan-returns/${returnId}`)
      .then(async (res) => {
        if (res.status === 404 || res.status === 400) {
          if (!cancelled) setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: GENERIC_ERROR_MESSAGE })
          return
        }
        const data: LoanReturnDetailApiResponse = await res.json()
        if (cancelled) return
        if (!data.loanReturn || data.loanReturn.facilityId !== id) {
          setState({ status: 'not-found' })
          return
        }
        setState({ status: 'done', loanReturn: data.loanReturn })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: GENERIC_ERROR_MESSAGE })
      })
    return () => {
      cancelled = true
    }
  }, [id, returnId])

  const labelStyle = { color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }
  const backLink = (
    <Link href={`/facilities/${id}/loan-returns`} className="text-sm hover:underline" style={{ color: '#4B5563' }}>
      ← 短貸返却の一覧へ戻る
    </Link>
  )

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6">{backLink}</div>
        <p className="text-sm" style={{ color: '#4B5563' }}>読み込み中...</p>
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6">{backLink}</div>
        <p className="text-sm" style={{ color: '#4B5563' }}>見つかりません</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6">{backLink}</div>
        <div className="px-4 py-3 rounded text-sm text-white" role="alert" style={{ backgroundColor: '#DC2626' }}>
          {state.message}
        </div>
      </div>
    )
  }

  const loanReturn = state.loanReturn

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">{backLink}</div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#4B5563' }}>
          Loan Return
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
        >
          {loanReturn.returnDatetime ? formatJstDateTime(loanReturn.returnDatetime) : '短貸返却'}
        </h1>
        <p className="mt-2 text-sm" style={{ color: '#4B5563' }}>
          {STATUS_LABEL[loanReturn.status] ?? loanReturn.status}
        </p>
        {loanReturn.status === 'cancelled' && (
          <p className="mt-1 text-sm" style={{ color: '#B91C1C' }}>
            <strong className="font-semibold">取り消し済み</strong>
            <span className="block">実際には返却されていない可能性があります</span>
          </p>
        )}
        {loanReturn.loanOrderId && (
          <p className="mt-2 text-sm" style={{ color: '#4B5563' }}>
            元の短貸発注:{' '}
            <span style={{ fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{loanReturn.loanOrderId}</span>
          </p>
        )}
      </div>

      <h2 className="mb-3 text-lg font-bold" style={{ color: '#072C2C' }}>明細</h2>
      {loanReturn.items.length === 0 ? (
        <p className="text-sm" style={{ color: '#4B5563' }}>明細がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>JAN</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>ロット</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>使用期限</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>数量</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>状態</th>
                </tr>
              </thead>
              <tbody>
                {loanReturn.items.map((item) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                    <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                      {item.jan}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                      {item.lot ?? '—'}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                      {item.ubd ?? '—'}
                    </td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#4B5563' }}>{item.quantity}</td>
                    <td className="px-6 py-4 text-sm whitespace-nowrap" style={{ color: '#4B5563' }}>
                      {item.status === 'cancelled' ? (
                        <span style={{ color: '#B91C1C' }}>
                          <strong className="font-semibold">取り消し済み</strong>
                          <span className="block text-xs font-normal">実際には返却されていない可能性があります</span>
                        </span>
                      ) : (
                        '有効'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
