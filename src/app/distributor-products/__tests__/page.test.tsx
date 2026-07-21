import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
const replaceMock = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => currentSearchParams,
}))

import DistributorProductsPage from '../page'

const items = [
  {
    id: 'dp1',
    productId: 'p1',
    maker: 'メーカーA',
    supplier: '仕入先A',
    name: '商品A',
    reimbursementPrice: 1000,
    quantity: 10,
    categoryId: 'c1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]
const categories = [
  { id: 'c1', name: 'カテゴリA', description: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

function mockFetchOnce(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    const result = handler(url, init)
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(result) })
  })
}

beforeEach(() => {
  pushMock.mockReset()
  replaceMock.mockReset()
  currentSearchParams = new URLSearchParams()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('DistributorProductsPage', () => {
  it('items と categories を並列取得して一覧を表示する', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    expect(await screen.findByText('商品A')).toBeInTheDocument()
    // WHY: 検索フィルタのカテゴリセレクトにも同名のoptionが表示されるため、
    //      一覧テーブルのセルであることを role="cell" で明示して曖昧さを排除する
    expect(screen.getByRole('cell', { name: 'カテゴリA' })).toBeInTheDocument()
  })

  it('新規登録ボタンで /distributor-products/new へ遷移', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('+ 新規登録'))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products/new')
  })

  it('編集ボタンで edit ページへ遷移', async () => {
    global.fetch = mockFetchOnce((url) => {
      if (url === '/api/distributor-products') return { items }
      if (url === '/api/categories') return { categories }
      return {}
    }) as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('編集'))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products/dp1/edit')
  })

  it('削除確認OKで DELETE を呼ぶ', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      if (url === '/api/distributor-products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('削除'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/distributor-products/dp1', { method: 'DELETE' })
    })
  })

  it('削除失敗時にエラーバナーを表示する', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: '削除に失敗しました' }) })
      if (url === '/api/distributor-products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('削除'))
    expect(await screen.findByText('削除に失敗しました')).toBeInTheDocument()
  })

  it('削除でfetchが例外を投げた場合もエラーバナーを表示する', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.reject(new Error('network error'))
      if (url === '/api/distributor-products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    await userEvent.click(screen.getByText('削除'))
    expect(await screen.findByText('削除に失敗しました')).toBeInTheDocument()
  })
})

describe('DistributorProductsPage 検索・絞り込み', () => {
  it('categoryId変更でAPIにcategoryIdパラメータが付与される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')

    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'c1')

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/distributor-products?categoryId=c1')
    })
  })

  it('keywordとcategoryIdの組み合わせがURLに両方反映される', async () => {
    currentSearchParams = new URLSearchParams('categoryId=c1')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, 'abc')

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/distributor-products?categoryId=c1&keyword=abc')
    })
  })

  it('URLのkeyword・categoryIdをもとに初期fetchする', async () => {
    currentSearchParams = new URLSearchParams('keyword=abc&categoryId=c1')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/distributor-products?keyword=abc&categoryId=c1')
    })
  })

  it('クリアで全条件リセット・URLパラメータも消える', async () => {
    currentSearchParams = new URLSearchParams('keyword=abc&categoryId=c1')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')

    await userEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(replaceMock).toHaveBeenCalledWith('/distributor-products')
  })

  it('検索結果0件時に「該当する販売店商品がありません」を表示する', async () => {
    currentSearchParams = new URLSearchParams('keyword=存在しない')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)

    expect(await screen.findByText('該当する販売店商品がありません')).toBeInTheDocument()
  })

  it('フェッチ未解決(isLoading中)は0件メッセージを表示しない（誤表示競合状態の防止）', async () => {
    currentSearchParams = new URLSearchParams('keyword=存在しない')
    let resolveItems!: (v: unknown) => void
    const pendingItems = new Promise((resolve) => { resolveItems = resolve })
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      return pendingItems
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/distributor-products?keyword=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84'))
    // フェッチが完了するまでは items.length === 0 であっても「0件」を確定表示しない
    expect(screen.queryByText('該当する販売店商品がありません')).not.toBeInTheDocument()

    resolveItems({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) })
    expect(await screen.findByText('該当する販売店商品がありません')).toBeInTheDocument()
  })

  it('categories取得失敗のエラーは、後続のitems取得成功で消えない（独立したuseEffect間でのerror state分離）', async () => {
    let resolveItems!: (v: unknown) => void
    const pendingItems = new Promise((resolve) => { resolveItems = resolve })
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
      return pendingItems
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<DistributorProductsPage />)

    // categories取得失敗のエラーが先に表示される
    expect(await screen.findByText('カテゴリの取得に失敗しました')).toBeInTheDocument()

    // items取得が後から成功しても、categoriesのエラー表示は消えない（別state管理のため）
    resolveItems({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    await screen.findByText('商品A')
    expect(screen.getByText('カテゴリの取得に失敗しました')).toBeInTheDocument()
  })

  // WHY: SPEC Part2 Set F-2「テスト観点: F-1に加え」に基づく。/products/page.tsxの
  //      「fetch失敗時に既存リストが消えずエラーバナーが出る」と同等の観点が
  //      distributor-products側では未実装だった（仕様カバレッジのレビュー指摘）
  it('検索の再フェッチが失敗しても既存リストが消えずエラーバナーが出る', async () => {
    let resolveSecondItems!: (v: unknown) => void
    const secondItemsPromise = new Promise((resolve) => { resolveSecondItems = resolve })
    let itemsCallCount = 0
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      }
      itemsCallCount += 1
      if (itemsCallCount === 1) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
      }
      return secondItemsPromise
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<DistributorProductsPage />)
    await screen.findByText('商品A')

    // WHY: router.replaceはモックのため実際のURL(useSearchParams戻り値)は変わらない。
    //      実際のNext.jsナビゲーションによる再レンダーを模して、searchParamsを直接更新してrerenderする
    currentSearchParams = new URLSearchParams('keyword=x')
    rerender(<DistributorProductsPage />)

    await waitFor(() => expect(itemsCallCount).toBe(2))
    resolveSecondItems({ ok: false, status: 500, json: () => Promise.resolve({}) })

    await waitFor(() => expect(screen.getByText('データの取得に失敗しました')).toBeInTheDocument())
    // 既存リストは消えない
    expect(screen.getByText('商品A')).toBeInTheDocument()
  })

  it('DELETE後、distributor-productsは再フェッチされるがcategoriesは再フェッチされない', async () => {
    let categoriesFetchCount = 0
    let itemsFetchCount = 0
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
      if (url === '/api/categories') {
        categoriesFetchCount += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      }
      itemsFetchCount += 1
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<DistributorProductsPage />)
    await screen.findByText('商品A')
    expect(categoriesFetchCount).toBe(1)
    expect(itemsFetchCount).toBe(1)

    await userEvent.click(screen.getByText('削除'))

    await waitFor(() => expect(itemsFetchCount).toBe(2))
    expect(categoriesFetchCount).toBe(1)
  })

  // WHY: デバウンス処理中に連続してkeyword/categoryIdが変わると、先に発火した古い
  //      リクエストが後から解決してもcancelledフラグ（page.tsx内のuseEffectクリーンアップ）
  //      で無視される必要がある（レビュー指摘: 正しさ・仕様カバレッジ・重複抜け漏れの
  //      3観点で重複して指摘された最重要ギャップ。products/page.tsxと同等のテストを追加）
  it('レースコンディション: 先に発火した古いitemsリクエストが後から解決しても新しい結果を上書きしない', async () => {
    let resolveFirstItems!: (v: unknown) => void
    const firstItemsPromise = new Promise((resolve) => { resolveFirstItems = resolve })
    let itemsCallCount = 0
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/categories') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
      }
      itemsCallCount += 1
      if (itemsCallCount === 1) return firstItemsPromise
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          items: [{ ...items[0], id: 'dp2', name: '新しい商品' }],
        }),
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<DistributorProductsPage />)
    await waitFor(() => expect(itemsCallCount).toBe(1))

    currentSearchParams = new URLSearchParams('keyword=b')
    rerender(<DistributorProductsPage />)
    await waitFor(() => expect(itemsCallCount).toBe(2))

    await screen.findByText('新しい商品')

    resolveFirstItems({ ok: true, status: 200, json: () => Promise.resolve({ items }) })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('商品A')).not.toBeInTheDocument()
    expect(screen.getByText('新しい商品')).toBeInTheDocument()
  })
})
