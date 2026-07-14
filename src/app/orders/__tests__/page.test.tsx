import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OrdersPage from '../page'

const push = vi.fn()
const replace = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => currentSearchParams,
}))

type FacilitiesResponse = { facilities: { id: string; name: string; createdAt: string; updatedAt: string }[]; isAdmin: boolean }

const f1 = { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const f2 = { id: 'f2', name: 'テスト施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

function mockFetch({
  facilitiesResponse,
  ordersHandler,
}: {
  facilitiesResponse: FacilitiesResponse
  ordersHandler: (url: string) => Response
}) {
  return vi.fn((url: string) => {
    // WHY(issue #20統合ゲート): 非adminに全施設が見えてしまう不整合を解消するため
    // /api/facilities から所属施設のみを返す /api/user-facilities に呼び出し先を変更した
    if (url === '/api/user-facilities') return Promise.resolve(jsonResponse(facilitiesResponse))
    if (url.startsWith('/api/orders')) return Promise.resolve(ordersHandler(url))
    return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
  })
}

describe('OrdersPage', () => {
  beforeEach(() => {
    push.mockReset()
    replace.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('非adminで所属施設が1件のみの場合、facility_idが自動セットされ施設ドロップダウンは表示されない', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('facility_id=f1'))
    })
    expect(screen.queryByRole('combobox', { name: '施設' })).not.toBeInTheDocument()
  })

  it('非adminで所属施設が複数の場合、施設ドロップダウンが表示され先頭施設で初回フェッチする', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1, f2], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: '施設' })).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('facility_id=f1'))
    })
  })

  it('adminの場合、初回フェッチにfacility_idを含めない', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1, f2], isAdmin: true },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/orders(\?(?!.*facility_id).*)?$/))
    })
  })

  it('ローディング中はスケルトンUIを表示する', async () => {
    // WHY: loading初期値がtrueのため、スケルトン自体はマウント直後から表示される。
    // このテストで検証したいのは「/api/ordersへの実フェッチが完了するまでスケルトンが
    // 表示され続け、レスポンス到着後に消える」ことなので、resolveOrdersを呼ぶ前に
    // 実際に/api/ordersへのfetch呼び出しが発生済みであることを先に確認する
    // （そうしないとresolveOrdersがまだ未割り当てのプレースホルダーを呼ぶだけで、
    // 実際のfetch Promiseは永遠に未解決のままになってしまう）
    let resolveOrders: (r: Response) => void = () => {}
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/user-facilities') return Promise.resolve(jsonResponse({ facilities: [f1], isAdmin: false }))
      if (url.startsWith('/api/orders')) {
        return new Promise<Response>((resolve) => {
          resolveOrders = resolve
        })
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(screen.getByTestId('order-history-skeleton')).toBeInTheDocument()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/orders'))
    })

    resolveOrders(jsonResponse({ orders: [], errors: [] }))
    await waitFor(() => {
      expect(screen.queryByTestId('order-history-skeleton')).not.toBeInTheDocument()
    })
  })

  // issue #20 レビュー指摘（仕様カバレッジ）回帰テスト: 期間フィルタのJST→UTC境界変換
  // （date_fromは選択日00:00:00+09:00、date_toは選択日23:59:59.999+09:00＝選択日を含む終端）
  // を検証する自動テストが存在しなかったため追加
  it('期間フィルタは選択したJST日付を00:00:00+09:00〜23:59:59.999+09:00の範囲としてUTC変換してAPIへ渡す', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('facility_id=f1'))
    })
    fetchMock.mockClear()

    await user.type(screen.getByLabelText('期間（開始）'), '2026-07-15')
    await user.type(screen.getByLabelText('期間（終了）'), '2026-07-15')
    await user.click(screen.getByRole('button', { name: '検索' }))

    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string)
      const target = calledUrls.find((u) => u.startsWith('/api/orders'))
      expect(target).toBeDefined()
      const url = new URL(target!, 'http://localhost')
      // 選択日 2026-07-15 の 00:00:00+09:00 は UTC で 2026-07-14T15:00:00.000Z
      expect(url.searchParams.get('date_from')).toBe('2026-07-14T15:00:00.000Z')
      // 選択日 2026-07-15 の 23:59:59.999+09:00（選択日を含む終端）は UTC で 2026-07-15T14:59:59.999Z
      expect(url.searchParams.get('date_to')).toBe('2026-07-15T14:59:59.999Z')
    })
  })

  it('種別チェックボックスを外すとURLが更新され再フェッチされる', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('facility_id=f1'))
    })
    fetchMock.mockClear()

    await user.click(screen.getByRole('checkbox', { name: '症例発注' }))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(expect.stringContaining('order_kinds=consumable%2Cloan%2Cloan_return'))
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('order_kinds=consumable%2Cloan%2Cloan_return'))
    })
  })

  // issue #20 レビュー指摘（important）回帰テスト: 種別チェックボックスを全て外した場合、
  // order_kinds パラメータ自体を省略する（=全種別対象と誤解釈される）のではなく、
  // 明示的に空値の order_kinds= を付与してリクエストする（UI状態と実データの矛盾を防ぐ）。
  it('種別チェックボックスを全て外すと order_kinds= を明示的に付与してリクエストする', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('facility_id=f1'))
    })

    await user.click(screen.getByRole('checkbox', { name: '症例発注' }))
    await user.click(screen.getByRole('checkbox', { name: '消耗品発注' }))
    await user.click(screen.getByRole('checkbox', { name: '短貸発注' }))
    fetchMock.mockClear()
    await user.click(screen.getByRole('checkbox', { name: '短貸返却' }))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(expect.stringContaining('order_kinds='))
    })
    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string)
      expect(calledUrls.some((u) => u.startsWith('/api/orders') && u.includes('order_kinds='))).toBe(true)
    })
  })

  // issue #20 レビュー指摘（正しさ）回帰テスト: order_kinds=（空文字）を含むURLから
  // 初期マウント（リロード・直リンク）した場合、「未指定→全種別」に誤フォールバックせず
  // 0種別選択の状態を維持してリクエストする（以前は !param のfalsy判定により
  // 空文字も未指定と誤判定し、無警告で全種別が表示されるバグがあった）
  it('order_kinds=を含むURLから初期マウントすると、0種別選択のまま維持してリクエストする', async () => {
    currentSearchParams = new URLSearchParams('order_kinds=')
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string)
      expect(calledUrls.some((u) => u.startsWith('/api/orders') && u.includes('order_kinds='))).toBe(true)
    })
    expect(screen.getByRole('checkbox', { name: '症例発注' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '消耗品発注' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '短貸発注' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '短貸返却' })).not.toBeChecked()
  })

  it('APIが失敗した場合、エラーバナーとリトライボタンを表示する', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ error: 'internal error' }, { status: 500 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByRole('button', { name: 'リトライ' })).toBeInTheDocument()
  })

  it('/api/ordersが401を返した場合、/loginにリダイレクトする', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () => jsonResponse({ error: '認証が必要です' }, { status: 401 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/login')
    })
  })

  it('非adminで所属施設が0件の場合、専用メッセージを表示しAPIを呼ばない', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [], isAdmin: false },
      ordersHandler: () => jsonResponse({ orders: [], errors: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('所属施設がありません。管理者にお問い合わせください。')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/orders'))
  })

  it('取得成功時、一部の種別でerrorsが返るとバナーを表示する', async () => {
    const fetchMock = mockFetch({
      facilitiesResponse: { facilities: [f1], isAdmin: false },
      ordersHandler: () =>
        jsonResponse({
          orders: [
            {
              id: 'o1',
              kind: 'case',
              facilityId: 'f1',
              displayDatetime: '2026-07-10T01:00:00Z',
              status: 'submitted',
              summaryLabel: 'テスト製品A',
            },
          ],
          errors: [{ kind: 'loan', message: 'timeout' }],
        }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OrdersPage />)

    expect(await screen.findByText('一部の発注種別を取得できませんでした')).toBeInTheDocument()
    expect(screen.getByText('テスト製品A')).toBeInTheDocument()
  })
})
