import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FacilitySummaryList } from '../FacilitySummaryList'
import type { DashboardFacilitySummary, LoanOutstandingSummary } from '@/types/dashboard'

const summaries: DashboardFacilitySummary[] = [
  {
    facilityId: 'f1',
    facilityName: '中央病院',
    caseOrderCount: 2,
    caseOrderLatestAt: '2026-06-01T00:00:00Z',
    consumableOrderCount: 0,
    consumableOrderLatestAt: null,
    loanOrderCount: 1,
    loanOrderLatestAt: '2026-06-02T00:00:00Z',
  },
  {
    facilityId: 'f2',
    facilityName: '東クリニック',
    caseOrderCount: 0,
    caseOrderLatestAt: null,
    consumableOrderCount: 0,
    consumableOrderLatestAt: null,
    loanOrderCount: 0,
    loanOrderLatestAt: null,
  },
]

const outstanding: LoanOutstandingSummary[] = [
  { facilityId: 'f1', facilityName: '中央病院', outstandingCount: 3 },
  { facilityId: 'f2', facilityName: '東クリニック', outstandingCount: 0 },
]

describe('FacilitySummaryList', () => {
  it('施設数だけカードが表示される', () => {
    render(<FacilitySummaryList facilitySummaries={summaries} loanOutstanding={outstanding} />)
    expect(screen.getByText('中央病院')).toBeInTheDocument()
    expect(screen.getByText('東クリニック')).toBeInTheDocument()
  })

  it('未返却件数が施設ごとに表示され、0件と1件以上で表示が区別される', () => {
    render(<FacilitySummaryList facilitySummaries={summaries} loanOutstanding={outstanding} />)
    expect(screen.getByText('未返却 3件')).toBeInTheDocument()
    expect(screen.getByText('未返却なし')).toBeInTheDocument()
  })

  it('施設リンクが /facilities/{id} を指す', () => {
    render(<FacilitySummaryList facilitySummaries={summaries} loanOutstanding={outstanding} />)
    expect(screen.getByRole('link', { name: /中央病院/ })).toHaveAttribute('href', '/facilities/f1')
  })

  it('0件のとき「データがありません」が表示される', () => {
    render(<FacilitySummaryList facilitySummaries={[]} loanOutstanding={[]} />)
    expect(screen.getByText('データがありません')).toBeInTheDocument()
  })
})
