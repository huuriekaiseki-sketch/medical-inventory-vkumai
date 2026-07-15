import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { OrderAmountReportRow } from '@/types/report'
import { ReportTable } from '../ReportTable'

function makeRow(overrides: Partial<OrderAmountReportRow> = {}): OrderAmountReportRow {
  return {
    facilityId: 'f1',
    facilityName: '施設A',
    caseOrderAmount: null,
    caseOrderCount: 0,
    caseOrderTotalCount: 0,
    consumableOrderAmount: null,
    consumableOrderCount: 0,
    consumableOrderTotalCount: 0,
    loanOrderAmount: null,
    loanOrderCount: 0,
    loanOrderTotalCount: 0,
    ...overrides,
  }
}

describe('ReportTable', () => {
  it('列見出しが「施設名 / 症例発注金額 / 消耗品発注金額 / 短貸発注金額 / 合計」の5列', () => {
    render(<ReportTable rows={[]} />)
    expect(screen.getByRole('columnheader', { name: '施設名' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '症例発注金額' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '消耗品発注金額' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '短貸発注金額' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '合計' })).toBeInTheDocument()
  })

  it('発注0件（全種別NULL・count=0）の施設は各セル・合計とも「-」と表示される', () => {
    render(<ReportTable rows={[makeRow()]} />)
    const row = screen.getByText('施設A').closest('tr')!
    // 施設名以外の4セル(症例/消耗品/短貸/合計)すべて「-」
    expect(row.textContent?.match(/-/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('発注はあるが単価データが一切ない場合は「-（金額データなし）」と表示される', () => {
    const row = makeRow({
      caseOrderAmount: null,
      caseOrderCount: 0,
      caseOrderTotalCount: 2,
      consumableOrderAmount: 12000,
      consumableOrderCount: 3,
      consumableOrderTotalCount: 3,
    })
    render(<ReportTable rows={[row]} />)
    expect(screen.getAllByText('-（金額データなし）').length).toBeGreaterThan(0)
  })

  it('集計値が0円の場合は「¥0」と表示される（金額データなしとは区別）', () => {
    const row = makeRow({
      caseOrderAmount: 0,
      caseOrderCount: 1,
      caseOrderTotalCount: 1,
      consumableOrderAmount: 5000,
      consumableOrderCount: 1,
      consumableOrderTotalCount: 1,
    })
    render(<ReportTable rows={[row]} />)
    expect(screen.getByText('¥0')).toBeInTheDocument()
  })

  it('金額はカンマ区切りの円表示になる', () => {
    const row = makeRow({
      caseOrderAmount: 1234567,
      caseOrderCount: 10,
      caseOrderTotalCount: 10,
    })
    render(<ReportTable rows={[row]} />)
    expect(screen.getAllByText('¥1,234,567').length).toBeGreaterThan(0)
  })

  it('（critical指摘の回帰）種別ごとに「発注0件」と「発注はあるが単価データなし」を正しく区別する', () => {
    // 症例発注: 本当に0件（caseOrderTotalCount=0）
    // 消耗品発注: 発注はあるが単価データなし（totalCount>0だがamount=null・count=0）
    // 短貸発注: 金額データあり（他種別に引きずられて「発注0件」と誤判定されないことを確認する行）
    const row = makeRow({
      caseOrderAmount: null,
      caseOrderCount: 0,
      caseOrderTotalCount: 0,
      consumableOrderAmount: null,
      consumableOrderCount: 0,
      consumableOrderTotalCount: 4,
      loanOrderAmount: 3000,
      loanOrderCount: 1,
      loanOrderTotalCount: 1,
    })
    render(<ReportTable rows={[row]} />)
    const tr = screen.getByText('施設A').closest('tr')!
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
    // 施設名, 症例(発注0件→'-'), 消耗品(単価データなし), 短貸(金額), 合計
    expect(cells[1]).toBe('-')
    expect(cells[2]).toBe('-（金額データなし）')
    expect(cells[3]).toBe('¥3,000')
    // 合計は「全種別が発注0件」ではない（短貸に金額あり）ため、NULLを0とみなして加算した値になる
    expect(cells[4]).toBe('¥3,000')
  })

  it('合計列は各種別のNULLを0とみなして加算する', () => {
    const row = makeRow({
      caseOrderAmount: 1000,
      caseOrderCount: 1,
      caseOrderTotalCount: 1,
      consumableOrderAmount: null,
      consumableOrderCount: 0,
      consumableOrderTotalCount: 0,
      loanOrderAmount: 2000,
      loanOrderCount: 1,
      loanOrderTotalCount: 1,
    })
    render(<ReportTable rows={[row]} />)
    expect(screen.getByText('¥3,000')).toBeInTheDocument()
  })

  it('（important指摘対応: 全種別に発注はあるが単価データが一切ない場合、合計は「¥0」ではなく「-（金額データなし）」と表示される', () => {
    // 3種別すべて totalCount>0（発注はある）だが amount=null（単価データなし）。
    // 「全種別発注0件」ではないため従来ロジックだと合計は¥0になってしまうが、
    // 実際には金額が不明なだけで確定0円ではないため区別が必要。
    const row = makeRow({
      caseOrderAmount: null,
      caseOrderCount: 0,
      caseOrderTotalCount: 2,
      consumableOrderAmount: null,
      consumableOrderCount: 0,
      consumableOrderTotalCount: 3,
      loanOrderAmount: null,
      loanOrderCount: 0,
      loanOrderTotalCount: 1,
    })
    render(<ReportTable rows={[row]} />)
    const tr = screen.getByText('施設A').closest('tr')!
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells[4]).toBe('-（金額データなし）')
  })

  it('ページ下部に単価データ開始日の注釈が表示される', () => {
    render(<ReportTable rows={[]} />)
    expect(screen.getByText(/以前の発注は金額データがありません/)).toBeInTheDocument()
  })
})
