import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CaseOrderDetailPage from '../page'

// WHY(issue #809 セットC): 症例発注の詳細は施設スコープの読み取り専用画面。
//      API層(セットB)はまだこのworktreeに実装されていない前提で、fetchはモックし
//      契約(CaseOrderDetailApiResponse/CaseOrderDetailApiErrorResponse、src/types/order.ts)通りの
//      レスポンスを返す想定でUIのみを検証する。

function params(id = 'f-1', orderId = 'o-1') {
  const p = Promise.resolve({ id, orderId }) as Promise<{ id: string; orderId: string }> & {
    status?: string
    value?: { id: string; orderId: string }
  }
  p.status = 'fulfilled'
  p.value = { id, orderId }
  return p
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

function makeCaseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    facilityId: 'f-1',
    caseDatetime: '2026-01-05T01:00:00Z',
    procedureName: '虫垂切除術',
    patientId: 'P-0001',
    patientInitials: 'T.Y.',
    gender: 'male',
    doctorName: '山田太郎',
    status: 'submitted',
    items: [
      { id: 'i-1', caseOrderId: 'o-1', jan: '4901234567890', lot: 'LOT-1', ubd: '2027-01-01', quantity: 2, unitPrice: 1000, createdAt: '2026-01-05T01:00:00Z' },
    ],
    createdAt: '2026-01-05T01:00:00Z',
    updatedAt: '2026-01-05T01:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('CaseOrderDetailPage', () => {
  it('読み込み中はローディング表示を出す', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<CaseOrderDetailPage params={params()} />)
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
  })

  it('正常系: 患者の情報(決定A=全項目)・症例日時・明細(ロット・使用期限含む)を表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder() }))))
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByRole('heading', { name: '虫垂切除術' })).toBeInTheDocument()
    expect(screen.getByText('P-0001')).toBeInTheDocument()
    expect(screen.getByText('T.Y.')).toBeInTheDocument()
    expect(screen.getByText('男性')).toBeInTheDocument()
    expect(screen.getByText('山田太郎')).toBeInTheDocument()
    expect(screen.getByText('4901234567890')).toBeInTheDocument()
    expect(screen.getByText('LOT-1')).toBeInTheDocument()
    expect(screen.getByText('2027-01-01')).toBeInTheDocument()
  })

  it('取り消し済みは文字で示す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder({ status: 'cancelled' }) })))
    )
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('取り消し済')).toBeInTheDocument()
  })

  // WHY(issue #824 決定A): 事実（取り消された）だけでは、リコールの担当者は「その患者は無関係かもしれない」
  //      という次の行動に辿り着けない。短貸返却の詳細ページと同じ重みで**意味**まで出ることを固定する。
  //      文言が返却側（「返却されていない」）に揃えられてしまう取り違えも、ここで落ちる
  it('取り消し済みのとき、事実だけでなく「実際には使用されていない可能性があります」と意味まで出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder({ status: 'cancelled' }) })))
    )
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('この発注は取り消されています')).toBeInTheDocument()
    expect(screen.getByText('実際には使用されていない可能性があります')).toBeInTheDocument()
    expect(screen.queryByText('実際には返却されていない可能性があります')).not.toBeInTheDocument()
  })

  it('取り消していない発注には、取り消しの文言を出さない（対照）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder({ status: 'submitted' }) })))
    )
    render(<CaseOrderDetailPage params={params()} />)

    await screen.findByText('山田太郎')
    expect(screen.queryByText('この発注は取り消されています')).not.toBeInTheDocument()
    expect(screen.queryByText('実際には使用されていない可能性があります')).not.toBeInTheDocument()
  })

  it('404のとき「見つかりません」と一覧へ戻るリンクを出す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'not found' }, { status: 404 }))))
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('見つかりません')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /一覧へ戻る/ })).toHaveAttribute('href', '/facilities/f-1/case-orders')
  })

  it('400(形式不正)のときも同じ「見つかりません」を出す(技術的なエラー文は出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'invalid input syntax for type uuid' }, { status: 400 }))))
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('見つかりません')).toBeInTheDocument()
    expect(screen.queryByText(/invalid input syntax/)).not.toBeInTheDocument()
  })

  it('URLの施設IDと記録のfacilityIdが食い違うとき「見つかりません」を出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder({ facilityId: 'f-other' }) })))
    )
    render(<CaseOrderDetailPage params={params('f-1', 'o-1')} />)

    expect(await screen.findByText('見つかりません')).toBeInTheDocument()
  })

  it('通信エラー時、既存画面と同じ形のエラーバナーを表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network error'))))
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('発注の取得に失敗しました')).toBeInTheDocument()
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
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByText('発注の取得に失敗しました')).toBeInTheDocument()
    expect(screen.queryByText('見つかりません')).not.toBeInTheDocument()
  })

  it('一覧へ戻るリンクがキーボードで辿れる(Linkとして描画される)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ caseOrder: makeCaseOrder() }))))
    render(<CaseOrderDetailPage params={params()} />)

    expect(await screen.findByRole('link', { name: /症例発注の一覧へ戻る/ })).toHaveAttribute(
      'href',
      '/facilities/f-1/case-orders'
    )
  })
})
