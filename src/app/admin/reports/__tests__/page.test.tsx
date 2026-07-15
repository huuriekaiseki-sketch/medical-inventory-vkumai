import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
let searchParamsValue = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsValue,
}))

import ReportsPage from '../page'

describe('ReportsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    pushMock.mockClear()
    searchParamsValue = new URLSearchParams()
  })

  it('初回アクセス時（URLパラメータなし）は自動集計せず空状態を表示する', () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    render(<ReportsPage />)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/期間を指定して/)).toBeInTheDocument()
  })

  it('「集計する」押下でURLが更新される', async () => {
    render(<ReportsPage />)

    await userEvent.type(screen.getByLabelText('開始日'), '2026-01-01')
    await userEvent.type(screen.getByLabelText('終了日'), '2026-01-31')
    await userEvent.click(screen.getByRole('button', { name: '集計する' }))

    expect(pushMock).toHaveBeenCalledWith('/admin/reports?date_from=2026-01-01&date_to=2026-01-31')
  })

  it('URLパラメータがある場合は集計APIを呼びテーブルを表示する', async () => {
    searchParamsValue = new URLSearchParams('date_from=2026-01-01&date_to=2026-01-31')
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [
          {
            facilityId: 'f1',
            facilityName: '施設A',
            caseOrderAmount: 1000,
            caseOrderCount: 1,
            caseOrderTotalCount: 1,
            consumableOrderAmount: null,
            consumableOrderCount: 0,
            consumableOrderTotalCount: 0,
            loanOrderAmount: null,
            loanOrderCount: 0,
            loanOrderTotalCount: 0,
          },
        ],
      }),
    } as Response)

    render(<ReportsPage />)

    expect(await screen.findByText('施設A')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reports?date_from=2026-01-01&date_to=2026-01-31')
  })

  it('集計中はローディング表示になる', async () => {
    searchParamsValue = new URLSearchParams('date_from=2026-01-01&date_to=2026-01-31')
    let resolveFetch!: (value: Response) => void
    vi.spyOn(global, 'fetch').mockReturnValue(
      new Promise<Response>((resolve) => { resolveFetch = resolve })
    )

    render(<ReportsPage />)

    expect(await screen.findByText('集計中...')).toBeInTheDocument()

    resolveFetch({ ok: true, json: async () => ({ rows: [] }) } as Response)
    await waitFor(() => expect(screen.queryByText('集計中...')).not.toBeInTheDocument())
  })

  it('集計APIが失敗した場合はエラーメッセージを表示する', async () => {
    searchParamsValue = new URLSearchParams('date_from=2026-01-01&date_to=2026-01-31')
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) } as Response)

    render(<ReportsPage />)

    expect(await screen.findByText('集計データの取得に失敗しました')).toBeInTheDocument()
  })
})
