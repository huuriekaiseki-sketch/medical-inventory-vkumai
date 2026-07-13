import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewsPage from '../page'

const push = vi.fn()
const replace = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => currentSearchParams,
}))

const facilities = [
  { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: 'テスト施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

function makeItem(id: string, occurredAt: string) {
  return {
    id,
    eventType: 'new_product',
    occurredAt,
    distributorProductId: `dp-${id}`,
    productName: `商品${id}`,
    maker: 'メーカー',
    supplier: '仕入先',
    fieldName: null,
    oldValue: null,
    newValue: null,
    facilityName: null,
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe('NewsPage', () => {
  beforeEach(() => {
    push.mockReset()
    replace.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('施設ID付きでニュース一覧を取得する', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [facilities[0]] }))
      if (url.startsWith('/api/news?facilityId=f1')) {
        return Promise.resolve(jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z')] }))
      }
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewsPage />)

    expect(await screen.findByText('商品1', { exact: false })).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/news?facilityId=f1&limit=20&offset=0')
    })
  })

  it('施設を切り替えるとニュース一覧が再取得されURLも更新される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities }))
      if (url.startsWith('/api/news?facilityId=f1')) return Promise.resolve(jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z')] }))
      if (url.startsWith('/api/news?facilityId=f2')) return Promise.resolve(jsonResponse({ items: [makeItem('2', '2026-07-08T00:00:00Z')] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<NewsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/news?facilityId=f1&limit=20&offset=0')
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    await user.selectOptions(select, 'f2')

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/news?facilityId=f2')
    })
  })

  it('取得件数がlimitと同じ場合「もっと見る」ボタンが表示され、押すとoffsetを加算して追加取得する', async () => {
    const page0 = Array.from({ length: 20 }, (_, i) => makeItem(`p0-${i}`, '2026-07-08T00:00:00Z'))
    const page1 = [makeItem('p1-0', '2026-07-07T00:00:00Z')]
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [facilities[0]] }))
      if (url === '/api/news?facilityId=f1&limit=20&offset=0') return Promise.resolve(jsonResponse({ items: page0 }))
      if (url === '/api/news?facilityId=f1&limit=20&offset=20') return Promise.resolve(jsonResponse({ items: page1 }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<NewsPage />)
    const loadMoreButton = await screen.findByRole('button', { name: 'もっと見る' })

    await user.click(loadMoreButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/news?facilityId=f1&limit=20&offset=20')
    })
    expect(await screen.findByText('商品p1-0', { exact: false })).toBeInTheDocument()
  })

  it('取得件数がlimit未満の場合「もっと見る」ボタンは表示されない', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [facilities[0]] }))
      if (url.startsWith('/api/news?facilityId=f1')) return Promise.resolve(jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z')] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewsPage />)
    await screen.findByText('商品1', { exact: false })
    expect(screen.queryByRole('button', { name: 'もっと見る' })).not.toBeInTheDocument()
  })

  it('管理者はfacilityId未指定時「全施設」がデフォルトで選択され、facilityId無しでニュースを取得する（issue #40）', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: true }))
      if (url === '/api/news?limit=20&offset=0') {
        return Promise.resolve(
          jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z'), makeItem('2', '2026-07-08T00:00:00Z')] })
        )
      }
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewsPage />)

    expect(await screen.findByText('商品1', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('商品2', { exact: false })).toBeInTheDocument()

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: '全施設' })).toBeInTheDocument()

    // 管理者の「全施設」モードではURLにfacilityIdクエリを付与しない
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('facilityId='))
  })

  it('管理者が「全施設」から特定施設に切り替えるとfacilityId付きで再取得しURLも更新される（issue #40）', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: true }))
      if (url === '/api/news?limit=20&offset=0') return Promise.resolve(jsonResponse({ items: [] }))
      if (url.startsWith('/api/news?facilityId=f1')) {
        return Promise.resolve(jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z')] }))
      }
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<NewsPage />)
    const select = await screen.findByRole('combobox') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe(''))

    await user.selectOptions(select, 'f1')

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/news?facilityId=f1')
    })
    expect(await screen.findByText('商品1', { exact: false })).toBeInTheDocument()
  })

  it('非adminには「全施設」の選択肢が表示されない', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities, isAdmin: false }))
      if (url.startsWith('/api/news?facilityId=f1')) {
        return Promise.resolve(jsonResponse({ items: [makeItem('1', '2026-07-08T00:00:00Z')] }))
      }
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewsPage />)
    await screen.findByText('商品1', { exact: false })
    expect(screen.queryByRole('option', { name: '全施設' })).not.toBeInTheDocument()
  })

  it('一度エラーが表示された後、「もっと見る」の再取得が成功したらエラーメッセージが消える（issue #25）', async () => {
    const page0 = Array.from({ length: 20 }, (_, i) => makeItem(`p0-${i}`, '2026-07-08T00:00:00Z'))
    const page1 = [makeItem('p1-0', '2026-07-07T00:00:00Z')]
    let loadMoreCallCount = 0
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [facilities[0]] }))
      if (url === '/api/news?facilityId=f1&limit=20&offset=0') return Promise.resolve(jsonResponse({ items: page0 }))
      if (url === '/api/news?facilityId=f1&limit=20&offset=20') {
        loadMoreCallCount += 1
        if (loadMoreCallCount === 1) {
          return Promise.resolve(jsonResponse({ error: 'server error' }, { status: 500 }))
        }
        return Promise.resolve(jsonResponse({ items: page1 }))
      }
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<NewsPage />)
    const loadMoreButton = await screen.findByRole('button', { name: 'もっと見る' })

    // 1回目: もっと見るの取得が失敗し、エラーメッセージが表示される
    await user.click(loadMoreButton)
    expect(await screen.findByText('データの取得に失敗しました')).toBeInTheDocument()

    // 2回目: 再度もっと見るを押して取得が成功すると、古いエラーメッセージが消える
    await user.click(loadMoreButton)
    await waitFor(() => {
      expect(screen.queryByText('データの取得に失敗しました')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('商品p1-0', { exact: false })).toBeInTheDocument()
  })

  it('施設が0件の場合、お知らせはありませんと表示される', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities') return Promise.resolve(jsonResponse({ facilities: [] }))
      return Promise.resolve(jsonResponse({ error: `unexpected ${url}` }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<NewsPage />)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/facilities')
    })
    expect(await screen.findByText('お知らせはありません')).toBeInTheDocument()
  })
})
