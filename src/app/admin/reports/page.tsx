'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { OrderAmountReportRow } from '@/types/report'
import { ReportFilters } from '@/components/reports/ReportFilters'
import { ReportTable } from '@/components/reports/ReportTable'

// WHY: issue #23 Part2 Set F。useSearchParams()を使うためSuspense必須ラップ
// （src/app/orders/page.tsxパターン踏襲）。

function ReportsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const dateFrom = searchParams.get('date_from') ?? ''
  const dateTo = searchParams.get('date_to') ?? ''
  // WHY: 未解決事項5「ページ初回表示は自動集計せず空状態」を、URLに期間パラメータが
  //      1つも無いかどうかで判定する。
  const hasFilter = Boolean(dateFrom || dateTo)

  const [rows, setRows] = useState<OrderAmountReportRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!hasFilter) return
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo) params.set('date_to', dateTo)
        const res = await fetch(`/api/admin/reports?${params.toString()}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setRows(data.rows ?? [])
      } catch {
        if (!cancelled) setError('集計データの取得に失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [hasFilter, dateFrom, dateTo])

  function handleSubmit(filter: { dateFrom: string; dateTo: string }) {
    const params = new URLSearchParams()
    if (filter.dateFrom) params.set('date_from', filter.dateFrom)
    if (filter.dateTo) params.set('date_to', filter.dateTo)
    const query = params.toString()
    router.push(query ? `/admin/reports?${query}` : '/admin/reports')
  }

  return (
    <div>
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-1"
          style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}
        >
          Reports
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
        >
          分析・レポート
        </h1>
      </div>

      {/* WHY: ブラウザの戻る/進むやURL直打ちでdateFrom/dateToが変わった場合、ReportFiltersの入力欄が
          マウント時点の値のまま固定されてしまう（内部stateの初期値はpropsの変化に追従しない）バグを防ぐ。
          key にURL由来の値を含めることでReactの推奨パターン(propsが変わったらstateをリセットする)通りに
          コンポーネントを作り直し、setState-in-effectを避けつつ入力欄をURLと同期させる。 */}
      <ReportFilters key={`${dateFrom}|${dateTo}`} dateFrom={dateFrom} dateTo={dateTo} onSubmit={handleSubmit} />

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>
          {error}
        </div>
      )}

      {!error && !hasFilter && (
        <p className="text-sm" style={{ color: '#6B7280' }}>
          期間を指定して「集計する」を押してください
        </p>
      )}

      {!error && hasFilter && loading && (
        <p className="text-sm" style={{ color: '#6B7280' }}>集計中...</p>
      )}

      {!error && hasFilter && !loading && <ReportTable rows={rows} />}
    </div>
  )
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>}>
      <ReportsPageInner />
    </Suspense>
  )
}
