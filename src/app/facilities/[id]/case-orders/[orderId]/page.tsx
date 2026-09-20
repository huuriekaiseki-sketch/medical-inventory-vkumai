'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { CaseOrder, CaseOrderDetailApiResponse } from '@/types/order'
import { formatJstDateTime } from '@/lib/format-date'

// WHY(issue #809 レビュー指摘: 型安全・データ層の整合 important): `Record<string, string>` だと
//      status/gender に新しい値が増えてもコンパイラが「ラベルの登録漏れ」を検知できない。
//      SPEC.md が「既存のバグ」として明記した事象（型には cancelled があるのにラベルが無く、
//      一覧に英字のまま出ていた）は、まさにこの緩さが黙って通した結果。CaseOrder の実際の
//      union型を鍵にして、値が増えたらここがコンパイルエラーになるようにする。
const STATUS_LABEL: Record<CaseOrder['status'], string> = {
  draft: '下書き',
  submitted: '提出済',
  cancelled: '取り消し済',
}

const GENDER_LABEL: Record<CaseOrder['gender'], string> = {
  male: '男性',
  female: '女性',
  other: 'その他',
}

const GENERIC_ERROR_MESSAGE = '発注の取得に失敗しました'

type ViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'done'; order: CaseOrder }

/**
 * 症例発注の詳細（issue #809）。読み取り専用。
 *
 * WHY(見つからない扱いを404/400で統一): SPEC Part2「先引き→施設判定」の route は
 *      存在しない・他施設・形式不正のどれも404/400で返し、技術的なエラー文は出さない。
 *      ここでは両方を同じ「見つかりません」に畳む（存在の有無・形式の正否を漏らさない）。
 * WHY(facilityId突き合わせ): URLの施設IDと記録のfacilityIdが食い違う（複数施設に
 *      所属する人が他施設の記録IDを踏んだ）場合も「見つかりません」にする。
 *      API側はクライアント入力の施設IDを信用しないため、この突き合わせは画面側の責務。
 */
export default function CaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string; orderId: string }>
}) {
  const { id, orderId } = use(params)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch(`/api/case-orders/${orderId}`)
      .then(async (res) => {
        if (res.status === 404 || res.status === 400) {
          if (!cancelled) setState({ status: 'not-found' })
          return
        }
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: GENERIC_ERROR_MESSAGE })
          return
        }
        const data: CaseOrderDetailApiResponse = await res.json()
        if (cancelled) return
        if (!data.caseOrder || data.caseOrder.facilityId !== id) {
          setState({ status: 'not-found' })
          return
        }
        setState({ status: 'done', order: data.caseOrder })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: GENERIC_ERROR_MESSAGE })
      })
    return () => {
      cancelled = true
    }
  }, [id, orderId])

  const labelStyle = { color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }
  const backLink = (
    <Link href={`/facilities/${id}/case-orders`} className="text-sm hover:underline" style={{ color: '#4B5563' }}>
      ← 症例発注の一覧へ戻る
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

  const order = state.order

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">{backLink}</div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#B03F00' }}>
          Case Order
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
        >
          {order.procedureName}
        </h1>
        <p className="mt-2 text-sm" style={{ color: '#4B5563' }}>
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
        {/* WHY(issue #824 決定A): 事実だけを書くと、リコールの担当者は「記録はあるが無効」としか読めず、
            **その患者は無関係かもしれない**という次の行動に辿り着けない。短貸返却の詳細ページは
            同じ論点で既に意味まで書いている（「実際には返却されていない可能性があります」）ので、
            同じ重みに揃える。文言は返却と変える——返却は「院内に残っている」、発注は「使っていない」で
            担当者が取るべき行動が逆向きになるため */}
        {order.status === 'cancelled' && (
          <p className="mt-1 text-sm" style={{ color: '#B91C1C' }}>
            <strong className="font-semibold">この発注は取り消されています</strong>
            <span className="block">実際には使用されていない可能性があります</span>
          </p>
        )}
      </div>

      <dl className="mb-8 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest" style={labelStyle}>症例日時</dt>
          <dd style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
            {order.caseDatetime ? formatJstDateTime(order.caseDatetime) : '-'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest" style={labelStyle}>患者ID</dt>
          <dd style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{order.patientId}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest" style={labelStyle}>イニシャル</dt>
          <dd style={{ color: '#111827' }}>{order.patientInitials}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest" style={labelStyle}>性別</dt>
          <dd style={{ color: '#111827' }}>{GENDER_LABEL[order.gender] ?? order.gender}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest" style={labelStyle}>医師名</dt>
          <dd style={{ color: '#111827' }}>{order.doctorName}</dd>
        </div>
      </dl>

      <h2 className="mb-3 text-lg font-bold" style={{ color: '#072C2C' }}>明細</h2>
      {order.items.length === 0 ? (
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
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>単価</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
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
                      {item.unitPrice ?? '—'}
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
