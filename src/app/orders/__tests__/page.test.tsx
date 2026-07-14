import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OrdersPage from '../page'

const push = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => currentSearchParams,
}))

const facilities = [{ id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]
const multiFacilities = [
  { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: 'テスト施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    kind: 'case_order',
    facilityId: 'f1',
    status: 'draft',
    summary: '虫垂切除術',
    createdAt: '2026-07-10T00:00:00Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe('OrdersPage', () => {
  beforeEach(() => {
    push.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初期表示で自施設の発注一覧をcreated_at降順で取得して表示する', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      if (url.startsWith('/api/orders?')) return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('虫垂切除術')).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/orders?facility_id=f1&limit=50&offset=0')
    })
  })

  it('タブ「短貸発注」をクリックするとURLが更新され短貸発注のみ取得する', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      if (url.includes('kind=loan_order')) return Promise.resolve(jsonResponse({ orders: [makeOrder({ id: 'o-2', kind: 'loan_order' })] }))
      if (url.startsWith('/api/orders?')) return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<OrdersPage />)
    await screen.findByText('虫垂切除術')

    await user.click(screen.getByRole('tab', { name: '短貸発注' }))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orders?kind=loan_order')
    })
  })

  it('キーボード操作（Enter）でタブが切り替えられる', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<OrdersPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/facilities'))

    const tab = screen.getByRole('tab', { name: '消耗品発注' })
    tab.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orders?kind=consumable_order')
    })
  })

  it('開始日を入力すると絞り込み結果が取得されoffsetがリセットされる', async () => {
    currentSearchParams = new URLSearchParams('kind=loan_order&offset=50')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder({ kind: 'loan_order' })] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/facilities'))

    const dateFromInput = screen.getByLabelText('開始日')
    fireEvent.change(dateFromInput, { target: { value: '2026-07-01' } })

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orders?kind=loan_order&dateFrom=2026-07-01')
    })
  })

  it('キーワードを入力すると絞り込み結果が取得される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/facilities'))

    const keywordInput = screen.getByLabelText('キーワード')
    fireEvent.change(keywordInput, { target: { value: 'ガーゼ' } })

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orders?keyword=%E3%82%AC%E3%83%BC%E3%82%BC')
    })
  })

  it('クリアボタンで全条件がリセットされる', async () => {
    currentSearchParams = new URLSearchParams('kind=loan_order&dateFrom=2026-07-01&keyword=abc&offset=50')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<OrdersPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/facilities'))

    await user.click(screen.getByRole('button', { name: 'クリア' }))

    expect(push).toHaveBeenCalledWith('/orders')
  })

  it('unreturned: true の短貸発注に「未返却」バッジが表示される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(
        jsonResponse({ orders: [makeOrder({ kind: 'loan_order', status: 'submitted', unreturned: true })] })
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('未返却')).toBeInTheDocument()
  })

  it('データ取得に失敗した場合エラーメッセージを表示し画面は壊れない', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ error: 'エラー' }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('発注履歴の取得に失敗しました')).toBeInTheDocument()
  })

  it('発注が0件の場合「発注履歴がありません」と表示される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('発注履歴がありません')).toBeInTheDocument()
  })

  it('URLのkindが未知の値の場合は「すべて」扱いにフォールバックし、不正なkindでAPIを呼ばない（実行時検証なしキャストの修正）', async () => {
    currentSearchParams = new URLSearchParams('kind=not_a_real_kind')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('虫垂切除術')).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/orders?facility_id=f1&limit=50&offset=0')
    })
    expect(screen.getByRole('tab', { name: 'すべて' })).toHaveAttribute('aria-selected', 'true')
  })

  it('フィルタ適用中に0件の場合「条件に一致する発注がありません」と表示される', async () => {
    currentSearchParams = new URLSearchParams('keyword=存在しない品目')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('条件に一致する発注がありません')).toBeInTheDocument()
  })

  // WHY: user_facilities は1ユーザーが複数施設に所属できるため（docs/agents/domain.md）、
  //      先頭施設に固定すると2件目以降の施設に所属するスタッフが自施設の発注を一切見られない
  //      （issue #20 レビュー指摘: 正しさ important, 複数施設ユーザー向け施設セレクタの欠如）
  it('複数施設に所属する場合は施設セレクタが表示され、切り替えるとURLと取得先facility_idが変わる', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: multiFacilities, isAdmin: false }))
      if (url.includes('facility_id=f2')) {
        return Promise.resolve(jsonResponse({ orders: [makeOrder({ id: 'o-2', facilityId: 'f2', summary: '施設B発注' })] }))
      }
      if (url.startsWith('/api/orders?')) return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    expect(await screen.findByText('虫垂切除術')).toBeInTheDocument()

    const select = screen.getByLabelText('施設を選択')
    fireEvent.change(select, { target: { value: 'f2' } })

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orders?facilityId=f2')
    })
  })

  it('URLのfacilityIdが自施設一覧に含まれる場合はその施設で取得する', async () => {
    currentSearchParams = new URLSearchParams('facilityId=f2')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: multiFacilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder({ id: 'o-2', facilityId: 'f2' })] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/orders?facility_id=f2&limit=50&offset=0')
    })
  })

  it('施設が1件のみの場合は施設セレクタが表示されない', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/facilities'))

    expect(screen.queryByLabelText('施設を選択')).not.toBeInTheDocument()
  })

  // WHY: 発注データ取得中もitemsは初期値[]のままのため、ローディング状態を管理しないと
  //      取得完了前に「発注履歴がありません」が一瞬表示されてしまう
  //      （issue #20 レビュー指摘: 正しさ important, ローディング状態未管理による空表示の誤表示）
  it('発注データ取得中は「発注履歴がありません」を表示しない', async () => {
    let resolveOrders!: (value: Response) => void
    const ordersPromise = new Promise<Response>((resolve) => {
      resolveOrders = resolve
    })
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      if (url.startsWith('/api/orders?')) return ordersPromise
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/orders?facility_id=f1&limit=50&offset=0')
    })
    expect(screen.queryByText('発注履歴がありません')).not.toBeInTheDocument()

    resolveOrders(jsonResponse({ orders: [] }))
    expect(await screen.findByText('発注履歴がありません')).toBeInTheDocument()
  })

  // WHY: レビュー指摘（重複・過剰実装 important）: ページネーションUIが欠落しており
  //      50件を超える発注がある施設では51件目以降を確認する手段が無かった
  it('返却件数がLIMIT(50)の場合は「次へ」が有効になり、クリックするとoffsetが進む', async () => {
    const fiftyOrders = Array.from({ length: 50 }, (_, i) => makeOrder({ id: `o-${i}`, summary: `術式${i}` }))
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: fiftyOrders }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<OrdersPage />)
    await screen.findByText('術式0')

    const nextButton = screen.getByRole('button', { name: '次へ' })
    expect(nextButton).toBeEnabled()
    await user.click(nextButton)

    expect(push).toHaveBeenCalledWith('/orders?offset=50')
  })

  it('返却件数がLIMIT未満の場合は「次へ」が無効になる', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    await screen.findByText('虫垂切除術')

    expect(screen.getByRole('button', { name: '次へ' })).toBeDisabled()
  })

  it('offset=0のときは「前へ」が無効になる', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)
    await screen.findByText('虫垂切除術')

    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled()
  })

  it('offset>0のとき「前へ」をクリックするとoffsetがLIMIT分戻る', async () => {
    currentSearchParams = new URLSearchParams('offset=50')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      return Promise.resolve(jsonResponse({ orders: [makeOrder()] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<OrdersPage />)
    await screen.findByText('虫垂切除術')

    const prevButton = screen.getByRole('button', { name: '前へ' })
    expect(prevButton).toBeEnabled()
    await user.click(prevButton)

    expect(push).toHaveBeenCalledWith('/orders')
  })
})
