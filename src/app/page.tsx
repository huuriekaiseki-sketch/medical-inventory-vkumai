'use client'

import { useEffect, useState } from 'react'
import type { DashboardData } from '@/types/dashboard'
import { FacilitySummaryList } from '@/components/dashboard/FacilitySummaryList'
import { RecentPriceChangeList } from '@/components/dashboard/RecentPriceChangeList'
import { DashboardShortcuts } from '@/components/dashboard/DashboardShortcuts'

// WHY: res.json() は any を返すため、レスポンス形状の破損時に .map 等が
// ランタイムで初めて失敗するのを防ぐため、最低限の形状チェックをかける
function isDashboardData(value: unknown): value is DashboardData {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  return (
    Array.isArray(d.facilitySummaries) &&
    Array.isArray(d.loanOutstanding) &&
    Array.isArray(d.recentPriceChanges) &&
    typeof d.isAdmin === 'boolean'
  )
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard')
      .then((r) => {
        if (!r.ok) throw new Error()
        return r.json()
      })
      .then((d: unknown) => {
        if (!isDashboardData(d)) throw new Error()
        if (!cancelled) setData(d)
      })
      .catch(() => {
        if (!cancelled) setError('ダッシュボードの取得に失敗しました')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-center gap-3 rounded px-4 py-3 text-sm font-medium text-white" style={{ backgroundColor: '#DC2626', borderRadius: '2px' }}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Dashboard
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          業務ダッシュボード
        </h1>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>
          施設別 直近発注サマリー
        </h2>
        <FacilitySummaryList
          facilitySummaries={data.facilitySummaries}
          loanOutstanding={data.loanOutstanding}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>
          最近の価格改定
        </h2>
        <RecentPriceChangeList items={data.recentPriceChanges} />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>
          管理ページ
        </h2>
        <DashboardShortcuts isAdmin={data.isAdmin} />
      </section>
    </div>
  )
}
