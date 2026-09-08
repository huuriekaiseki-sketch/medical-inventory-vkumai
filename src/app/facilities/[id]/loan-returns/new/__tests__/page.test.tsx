import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// WHY: issue #20 レビュー指摘(critical): 「未返却」バッジ機能の書き込み経路(loan_order_id紐付け)
//      が実際には配線されておらず、返却フォームからloan_order_idを選択・送信できなかった。
//      対象の短貸発注(未返却のもの)を選択でき、POST /api/loan-returns へloanOrderIdとして
//      渡ることを確認する。
//
// WHY(2026-09-08 に形が変わった): 分割返却を表せるようにしたので、対象の短貸発注を選ぶと
//      **その明細と残数が並び、行ごとに返す数量を入れる**形になった（20260908030000）。
//      対象を選ばないときは従来の自由入力のまま。両方の経路を測る。
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import NewLoanReturnPage from '../page'

// React 19 の use() は status/value を持つ thenable を同期的に解決する。
// テストでは解決済み thenable を渡して Suspense を回避する。
function params() {
  const p = Promise.resolve({ id: 'f-1' }) as Promise<{ id: string }> & {
    status?: string
    value?: { id: string }
  }
  p.status = 'fulfilled'
  p.value = { id: 'f-1' }
  return p
}

const unreturnedOrders = [
  { id: 'lo-1', kind: 'loan_order', facilityId: 'f-1', status: 'submitted', summary: 'PCI（メドトロニック）', createdAt: '2026-06-24T00:00:00Z', unreturned: true, outstandingQuantity: 3 },
  { id: 'lo-2', kind: 'loan_order', facilityId: 'f-1', status: 'draft', summary: 'CAG（アボット）', createdAt: '2026-06-20T00:00:00Z', unreturned: false },
]

// 対象を選んだときに読みに行く発注の明細。5 本借りて 2 本返した = 残り 3
const loanOrders = [
  {
    id: 'lo-1',
    facilityId: 'f-1',
    procedureName: 'PCI',
    maker: 'メドトロニック',
    status: 'submitted',
    createdAt: '2026-06-24T00:00:00Z',
    updatedAt: '2026-06-24T00:00:00Z',
    items: [
      { id: 'loi-1', loanOrderId: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 5, unitPrice: null, createdAt: '2026-06-24T00:00:00Z', returnedQuantity: 2 },
      { id: 'loi-2', loanOrderId: 'lo-1', jan: '490002', name: 'シースB', quantity: 1, unitPrice: null, createdAt: '2026-06-24T00:00:00Z', returnedQuantity: 1 },
    ],
  },
]

beforeEach(() => {
  pushMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setupFetch({ postOk = true, ordersOk = true } = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: postOk, status: postOk ? 201 : 400, json: () => Promise.resolve(postOk ? { loanReturn: { id: 'lr-1' } } : { error: '指定された短貸発注が見つかりません' }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/orders')) {
      return Promise.resolve({ ok: ordersOk, status: ordersOk ? 200 : 500, json: () => Promise.resolve({ orders: unreturnedOrders }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/loan-orders')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: loanOrders }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
}

describe('NewLoanReturnPage', () => {
  it('未返却の短貸発注のみが選択肢として表示される（返却済み・下書きは除外）', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<NewLoanReturnPage params={params()} />)
    expect(await screen.findByRole('option', { name: 'PCI（メドトロニック）' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'CAG（アボット）' })).not.toBeInTheDocument()
  })

  it('対象を選ぶと残っている明細だけが並び、行ごとに返す数量を入れて送れる', async () => {
    const fetchMock = setupFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    render(<NewLoanReturnPage params={params()} />)

    await screen.findByRole('option', { name: 'PCI（メドトロニック）' })
    await userEvent.selectOptions(screen.getByLabelText('対象の短貸発注（任意）'), 'lo-1')

    // 残り 3 のカテーテルAは出る。残り 0 のシースBは出ない
    const qty = await screen.findByLabelText('カテーテルA の返す数')
    expect(screen.queryByLabelText('シースB の返す数')).not.toBeInTheDocument()

    await userEvent.clear(qty)
    await userEvent.type(qty, '2')
    await userEvent.type(screen.getByLabelText(/返却日時/), '2026-06-24T15:00')
    await userEvent.click(screen.getByRole('button', { name: '返却する' }))

    const postCall = fetchMock.mock.calls.find(call => (call[1] as RequestInit)?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.loanOrderId).toBe('lo-1')
    expect(body.items).toEqual([
      { jan: '490001', quantity: 2, loanOrderItemId: 'loi-1' },
    ])
  })

  it('対象を選んだのに返す数量が 0 のままなら送信しない', async () => {
    // WHY: 数量 0 の明細を送ると DB の CHECK（数量は 1 以上）で 23514 になり、
    //      利用者には「何が悪いか」が伝わらない。画面で止める
    const fetchMock = setupFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    render(<NewLoanReturnPage params={params()} />)

    await screen.findByRole('option', { name: 'PCI（メドトロニック）' })
    await userEvent.selectOptions(screen.getByLabelText('対象の短貸発注（任意）'), 'lo-1')
    await screen.findByLabelText('カテーテルA の返す数')
    await userEvent.type(screen.getByLabelText(/返却日時/), '2026-06-24T15:00')
    await userEvent.click(screen.getByRole('button', { name: '返却する' }))

    expect(fetchMock.mock.calls.find(call => (call[1] as RequestInit)?.method === 'POST')).toBeUndefined()
    expect(screen.getByText('返す数量を 1 つ以上入力してください')).toBeInTheDocument()
  })

  it('対象の短貸発注を選択しない場合、POST /api/loan-returnsにloanOrderIdは含まれない', async () => {
    const fetchMock = setupFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    render(<NewLoanReturnPage params={params()} />)

    await screen.findByRole('option', { name: 'PCI（メドトロニック）' })
    await userEvent.type(screen.getByLabelText(/返却日時/), '2026-06-24T15:00')
    await userEvent.click(screen.getByRole('button', { name: '返却する' }))

    const postCall = fetchMock.mock.calls.find(call => (call[1] as RequestInit)?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.loanOrderId).toBeUndefined()
  })

  it('未返却短貸発注一覧の取得に失敗しても、フォーム自体は利用できる', async () => {
    global.fetch = setupFetch({ ordersOk: false }) as unknown as typeof fetch
    render(<NewLoanReturnPage params={params()} />)
    expect(await screen.findByLabelText(/返却日時/)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '選択しない' })).toBeInTheDocument()
  })
})
