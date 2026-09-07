import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// WHY: issue #757 の 4・24。画面で確かめるのは 4 つ:
//        - 既定で変更の記録を読みに行く
//        - 種別を切り替えると拒否の記録に変わる
//        - 絞り込みが URL に載る（共有・再現できる）
//        - 取得に失敗したら黙らずに知らせる

const pushMock = vi.fn()
let searchParamsValue = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsValue,
}))

import AuditPage from '../page'

const CHANGE = {
  id: 'x1',
  occurredAt: '2026-09-07T00:00:00Z',
  tableName: 'case_orders',
  action: 'UPDATE',
  actorId: 'a1',
  actorRole: 'authenticated',
  facilityId: 'f1',
  rowId: 'r1',
  changedColumns: ['status'],
}

const DENIAL = {
  id: 'd1',
  occurredAt: '2026-09-07T01:00:00Z',
  guard: 'facility',
  reason: 'forbidden',
  actorId: 'a1',
  facilityId: 'f1',
  route: '/api/orders',
  method: 'GET',
}

describe('AuditPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    pushMock.mockClear()
    searchParamsValue = new URLSearchParams()
  })

  it('既定で変更の記録を読み、表に出す', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'changes', changes: [CHANGE] }),
    } as Response)

    render(<AuditPage />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0][0])).toContain('kind=changes')
    expect(await screen.findByText('case_orders')).toBeInTheDocument()
    expect(screen.getByText('更新')).toBeInTheDocument()
    expect(screen.getByText('status')).toBeInTheDocument()
  })

  it('kind=denials では拒否の記録を読み、境界と理由を日本語で出す', async () => {
    searchParamsValue = new URLSearchParams('kind=denials')
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'denials', denials: [DENIAL] }),
    } as Response)

    render(<AuditPage />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0][0])).toContain('kind=denials')
    expect(await screen.findByText('施設の境界')).toBeInTheDocument()
    expect(screen.getByText('権限がない')).toBeInTheDocument()
    expect(screen.getByText('GET /api/orders')).toBeInTheDocument()
  })

  it('絞り込みは URL に載る（同じ画面を共有できる）', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'changes', changes: [] }),
    } as Response)

    render(<AuditPage />)

    await userEvent.type(screen.getByLabelText('開始日'), '2026-09-01')
    await userEvent.type(screen.getByLabelText('終了日'), '2026-09-07')
    await userEvent.click(screen.getByRole('button', { name: '絞り込む' }))

    expect(pushMock).toHaveBeenCalledWith(
      '/admin/audit?kind=changes&date_from=2026-09-01&date_to=2026-09-07'
    )
  })

  it('取得に失敗したら黙らずに知らせる', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response)

    render(<AuditPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('監査ログの取得に失敗しました')
  })

  it('0 件のときは、二要素認証を通していない管理者には空になることを伝える', async () => {
    searchParamsValue = new URLSearchParams('kind=denials')
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'denials', denials: [] }),
    } as Response)

    render(<AuditPage />)

    expect(await screen.findByText(/二要素認証/)).toBeInTheDocument()
  })
})
