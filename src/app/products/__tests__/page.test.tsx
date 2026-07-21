import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductsPage from '../page'

const push = vi.fn()
const replace = vi.fn()
let currentSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => currentSearchParams,
}))

describe('ProductsPage handleDelete', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    push.mockReset()
    replace.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  it('一覧取得が失敗した場合はエラーメッセージを表示する（catch漏れ防止）', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch

    render(<ProductsPage />)

    await screen.findByText('デバイスの取得に失敗しました')
  })

  it('削除後の再取得は、削除時点のキーワード絞り込み条件を維持する（回帰防止）', async () => {
    currentSearchParams = new URLSearchParams('keyword=カテーテル')
    const calls: string[] = []
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        calls.push('delete')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      }
      calls.push(url)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1' }] }) })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)
    await screen.findByText('4900000000001')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])

    await waitFor(() => expect(calls.filter((c) => c.includes('/api/products')).length).toBe(2))
    // WHY: DELETE後の再フェッチが絞り込み条件を無視して全件fetchに切り替わっていないか検証する
    //      （レビュー指摘: 正しさ important — F-1のDELETE後再フェッチ挙動が仕様に明記されておらず、
    //      keywordが維持されるかどうかテストで裏付けられていなかった）
    expect(calls.filter((c) => c.includes('/api/products'))).toEqual([
      '/api/products?keyword=%E3%82%AB%E3%83%86%E3%83%BC%E3%83%86%E3%83%AB',
      '/api/products?keyword=%E3%82%AB%E3%83%86%E3%83%BC%E3%83%86%E3%83%AB',
    ])
  })

  it('削除はDELETEの完了(await)を待ってから再取得する', async () => {
    const calls: string[] = []
    let resolveDelete: (v: unknown) => void = () => {}
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        calls.push('delete-start')
        return new Promise((resolve) => {
          resolveDelete = () => {
            calls.push('delete-end')
            resolve({ ok: true, json: () => Promise.resolve({}) })
          }
        })
      }
      calls.push('list')
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1' }] }) })
    }) as unknown as typeof fetch

    render(<ProductsPage />)
    await screen.findByText('4900000000001')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])
    // DELETE開始済み・終了前なので再取得(list)はまだ起きていない
    expect(calls).toContain('delete-start')
    expect(calls.filter((c) => c === 'list')).toHaveLength(1)

    resolveDelete(null)
    await waitFor(() => expect(calls.filter((c) => c === 'list')).toHaveLength(2))
    expect(calls.indexOf('delete-end')).toBeLessThan(calls.lastIndexOf('list'))
  })

  it('一覧取得(GET)が失敗した場合、エラーバナーを表示する', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }) as unknown as typeof fetch

    render(<ProductsPage />)

    expect(await screen.findByText('デバイスの取得に失敗しました')).toBeInTheDocument()
  })

  it('削除(DELETE)がネットワーク例外を投げた場合、alertでユーザーに通知する', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.reject(new Error('network error'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1' }] }) })
    }) as unknown as typeof fetch

    render(<ProductsPage />)
    await screen.findByText('4900000000001')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])

    await waitFor(() => expect(global.alert).toHaveBeenCalledWith('削除に失敗しました'))
  })
})

describe('ProductsPage 検索・絞り込み', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    push.mockReset()
    replace.mockReset()
    currentSearchParams = new URLSearchParams()
  })

  it('URLに?keyword=abcがあると初期状態で絞り込まれた状態でfetchする', async () => {
    currentSearchParams = new URLSearchParams('keyword=abc')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ products: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/products?keyword=abc')
    })
    expect(screen.getByLabelText('キーワード')).toHaveValue('abc')
  })

  it('キーワード変更でURLがrouter.replaceで更新される', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ products: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/products'))

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, 'カテーテル')

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/products?keyword=%E3%82%AB%E3%83%86%E3%83%BC%E3%83%86%E3%83%AB')
    })
  })

  it('クリアでURLパラメータが消える', async () => {
    currentSearchParams = new URLSearchParams('keyword=abc')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ products: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/products?keyword=abc'))

    await userEvent.click(screen.getByRole('button', { name: 'クリア' }))

    expect(replace).toHaveBeenCalledWith('/products')
  })

  it('検索結果0件時に「該当する製品がありません」を表示する', async () => {
    currentSearchParams = new URLSearchParams('keyword=存在しない')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ products: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)

    expect(await screen.findByText('該当する製品がありません')).toBeInTheDocument()
  })

  it('フェッチ未解決(isLoading中)は0件メッセージを表示しない（誤表示競合状態の防止）', async () => {
    currentSearchParams = new URLSearchParams('keyword=存在しない')
    let resolveFetch!: (v: unknown) => void
    const pending = new Promise((resolve) => { resolveFetch = resolve })
    const fetchMock = vi.fn().mockReturnValue(pending)
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ProductsPage />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // フェッチが完了するまでは products.length === 0 であっても「0件」を確定表示しない
    expect(screen.queryByText('該当する製品がありません')).not.toBeInTheDocument()

    resolveFetch({ ok: true, json: () => Promise.resolve({ products: [] }) })
    expect(await screen.findByText('該当する製品がありません')).toBeInTheDocument()
  })

  it('検索エラーはrole="alert"かつbg-red-50/text-red-700スタイルで表示する（SPEC必須要件）', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }) as unknown as typeof fetch

    render(<ProductsPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('デバイスの取得に失敗しました')
    expect(alert.className).toContain('bg-red-50')
    expect(alert.className).toContain('text-red-700')
  })

  it('fetch失敗時に既存リストが消えずエラーバナーが出る', async () => {
    let resolveSecond!: (v: unknown) => void
    const secondPromise = new Promise((resolve) => { resolveSecond = resolve })
    let callCount = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1
      if (callCount === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1', name: 'P1', maker: null }] }) })
      }
      return secondPromise
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<ProductsPage />)
    await screen.findByText('4900000000001')

    // WHY: router.replaceはモックのため呼んでも実際のURL(useSearchParams戻り値)は変わらない。
    //      実際のNext.jsナビゲーションによる再レンダーを模して、searchParamsを直接更新してrerenderする
    currentSearchParams = new URLSearchParams('keyword=x')
    rerender(<ProductsPage />)

    await waitFor(() => expect(callCount).toBe(2))
    resolveSecond({ ok: false, status: 500, json: () => Promise.resolve({}) })

    await waitFor(() => expect(screen.getByText('デバイスの取得に失敗しました')).toBeInTheDocument())
    // 既存リストは消えない
    expect(screen.getByText('4900000000001')).toBeInTheDocument()
  })

  // WHY: デバウンス処理中に連続してkeywordが変わると、先に発火した古いリクエストが
  //      後から解決してもcancelledフラグ（page.tsx内のuseEffectクリーンアップ）で
  //      無視される必要がある。この保護が無いと、古い検索結果が新しい検索結果を
  //      上書きしてしまう（レビュー指摘: 正しさ・仕様カバレッジ・重複抜け漏れの3観点で
  //      重複して指摘された最重要ギャップ）
  it('レースコンディション: 先に発火した古いリクエストが後から解決しても新しい結果を上書きしない', async () => {
    let resolveFirst!: (v: unknown) => void
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve })
    let callCount = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1
      if (callCount === 1) return firstPromise
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ products: [{ id: '2', jan: '4900000000002', ref: 'R2', name: 'New', maker: null }] }),
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { rerender } = render(<ProductsPage />)
    await waitFor(() => expect(callCount).toBe(1))

    // 1回目のリクエストが未解決のうちにkeywordを変更 → 2回目のリクエストが発火する
    currentSearchParams = new URLSearchParams('keyword=b')
    rerender(<ProductsPage />)
    await waitFor(() => expect(callCount).toBe(2))

    // 新しい(2回目の)リクエストの結果が表示される
    await screen.findByText('4900000000002')

    // 古い(1回目の)リクエストが今頃解決しても、表示は上書きされない
    resolveFirst({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1', name: 'Old', maker: null }] }) })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('4900000000001')).not.toBeInTheDocument()
    expect(screen.getByText('4900000000002')).toBeInTheDocument()
  })
})
