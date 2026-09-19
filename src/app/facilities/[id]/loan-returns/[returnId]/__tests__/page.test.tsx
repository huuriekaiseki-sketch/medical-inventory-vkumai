import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoanReturnDetailPage from '../page'

// WHY(issue #809 セットC): 短貸返却の詳細は施設スコープの読み取り専用画面。
//      API層(セットB)はまだこのworktreeに実装されていない前提で、fetchはモックし
//      契約(LoanReturnDetailApiResponse/LoanReturnDetailApiErrorResponse、src/types/order.ts)通りの
//      レスポンスを返す想定でUIのみを検証する。

function params(id = 'f-1', returnId = 'r-1') {
  const p = Promise.resolve({ id, returnId }) as Promise<{ id: string; returnId: string }> & {
    status?: string
    value?: { id: string; returnId: string }
  }
  p.status = 'fulfilled'
  p.value = { id, returnId }
  return p
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

function makeLoanReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    facilityId: 'f-1',
    returnDatetime: '2026-01-06T01:00:00Z',
    status: 'returned',
    items: [
      { id: 'i-1', loanReturnId: 'r-1', jan: '4901234500000', lot: 'LOT-9', ubd: '2027-05-01', quantity: 1, createdAt: '2026-01-06T01:00:00Z', status: 'active' },
    ],
    createdAt: '2026-01-06T01:00:00Z',
    updatedAt: '2026-01-06T01:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoanReturnDetailPage', () => {
  it('読み込み中はローディング表示を出す', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<LoanReturnDetailPage params={params()} />)
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
  })

  it('正常系: 返却日時・状態・明細(ロット・使用期限含む)を表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ loanReturn: makeLoanReturn() }))))
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('返却済')).toBeInTheDocument()
    expect(screen.getByText('4901234500000')).toBeInTheDocument()
    expect(screen.getByText('LOT-9')).toBeInTheDocument()
    expect(screen.getByText('2027-05-01')).toBeInTheDocument()
  })

  it('回ごとの取り消しを文字で示し、注意文を添える(ロット検索と同じ文言)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ loanReturn: makeLoanReturn({ status: 'cancelled' }) })))
    )
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('取り消し済み')).toBeInTheDocument()
    expect(screen.getByText(/実際には返却されていない可能性があります/)).toBeInTheDocument()
  })

  it('明細ごとの取り消しを文字で示し、注意文を添える', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            loanReturn: makeLoanReturn({
              items: [
                { id: 'i-1', loanReturnId: 'r-1', jan: '4901234500000', lot: 'LOT-9', ubd: '2027-05-01', quantity: 1, createdAt: '2026-01-06T01:00:00Z', status: 'cancelled' },
              ],
            }),
          })
        )
      )
    )
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('取り消し済み')).toBeInTheDocument()
    expect(screen.getByText(/実際には返却されていない可能性があります/)).toBeInTheDocument()
  })

  it('404のとき「見つかりません」と一覧へ戻るリンクを出す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'not found' }, { status: 404 }))))
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('見つかりません')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /一覧へ戻る/ })).toHaveAttribute('href', '/facilities/f-1/loan-returns')
  })

  it('URLの施設IDと記録のfacilityIdが食い違うとき「見つかりません」を出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ loanReturn: makeLoanReturn({ facilityId: 'f-other' }) })))
    )
    render(<LoanReturnDetailPage params={params('f-1', 'r-1')} />)

    expect(await screen.findByText('見つかりません')).toBeInTheDocument()
  })

  it('通信エラー時、既存画面と同じ形のエラーバナーを表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network error'))))
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('返却の取得に失敗しました')).toBeInTheDocument()
  })

  it('200だがJSONでない応答を「見つかりません」と表示しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<!doctype html><title>MFA</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        )
      )
    )
    render(<LoanReturnDetailPage params={params()} />)

    expect(await screen.findByText('返却の取得に失敗しました')).toBeInTheDocument()
    expect(screen.queryByText('見つかりません')).not.toBeInTheDocument()
  })
})
