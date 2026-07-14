'use client'

import Link from 'next/link'
import type { DashboardFacilitySummary, LoanOutstandingSummary } from '@/types/dashboard'

type FacilitySummaryListProps = {
  facilitySummaries: DashboardFacilitySummary[]
  loanOutstanding: LoanOutstandingSummary[]
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function FacilitySummaryList({ facilitySummaries, loanOutstanding }: FacilitySummaryListProps) {
  if (facilitySummaries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center rounded bg-white shadow-sm" style={{ border: '1px solid #E5E7EB' }}>
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>データがありません</p>
      </div>
    )
  }

  const outstandingByFacility = new Map(loanOutstanding.map((o) => [o.facilityId, o.outstandingCount]))

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {facilitySummaries.map((summary) => {
        const outstandingCount = outstandingByFacility.get(summary.facilityId) ?? 0
        return (
          <div
            key={summary.facilityId}
            className="rounded bg-white p-5 shadow-sm"
            style={{ border: '1px solid #E5E7EB' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <Link
                href={`/facilities/${summary.facilityId}`}
                className="text-lg font-bold hover:underline"
                style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}
              >
                {summary.facilityName}
              </Link>
              {outstandingCount > 0 ? (
                <span
                  className="rounded-full px-3 py-1 text-xs font-semibold text-white"
                  style={{ backgroundColor: '#DC2626' }}
                >
                  未返却 {outstandingCount}件
                </span>
              ) : (
                <span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}>
                  未返却なし
                </span>
              )}
            </div>
            <dl className="space-y-1 text-sm" style={{ color: '#374151' }}>
              <Link href={`/facilities/${summary.facilityId}/case-orders`} className="flex justify-between rounded px-1 -mx-1 hover:bg-[#EDEADE]/40">
                <dt>症例発注</dt>
                <dd>{summary.caseOrderCount}件 / {formatDateTime(summary.caseOrderLatestAt)}</dd>
              </Link>
              <Link href={`/facilities/${summary.facilityId}/consumable-orders`} className="flex justify-between rounded px-1 -mx-1 hover:bg-[#EDEADE]/40">
                <dt>消耗品発注</dt>
                <dd>{summary.consumableOrderCount}件 / {formatDateTime(summary.consumableOrderLatestAt)}</dd>
              </Link>
              <Link href={`/facilities/${summary.facilityId}/loan-orders`} className="flex justify-between rounded px-1 -mx-1 hover:bg-[#EDEADE]/40">
                <dt>短貸発注</dt>
                <dd>{summary.loanOrderCount}件 / {formatDateTime(summary.loanOrderLatestAt)}</dd>
              </Link>
            </dl>
          </div>
        )
      })}
    </div>
  )
}
