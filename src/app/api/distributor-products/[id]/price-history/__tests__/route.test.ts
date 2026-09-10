import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockGetDistributorProduct = vi.fn()
const mockGetPriceHistory = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/distributor-products/repository', () => ({
  getDistributorProduct: (...args: unknown[]) => mockGetDistributorProduct(...args),
}))

vi.mock('@/lib/price-histories/repository', () => ({
  getPriceHistory: (...args: unknown[]) => mockGetPriceHistory(...args),
}))

const params = Promise.resolve({ id: 'dp1' })
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/distributor-products/[id]/price-history', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, { params })
    expect(res.status).toBe(401)
    expect(mockGetDistributorProduct).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetDistributorProduct.mockResolvedValue({ id: 'dp1' })
    mockGetPriceHistory.mockResolvedValue([])
    const res = await GET(new Request('http://localhost') as never, { params })
    expect(res.status).toBe(200)
  })

  // WHY(2026-09-11): ここは `err.message` をそのまま 500 で返していた。
  //      DB の生エラー（制約名・列名・接続情報）が利用者へ出る形で、
  //      2026-07-26 に `ClientVisibleError` を入れたときに拾われていなかった 1 件。
  //      **手で数えたときは見落とし**、同じ日に作った走査
  //      （scripts/lib/scan-raw-error-response.mjs）が見つけた——
  //      「変数へ移してから返す」形だったため。戻したら落ちる形で固定する。
  it('DB のエラーは生のメッセージを返さない', async () => {
    authenticated()
    mockGetDistributorProduct.mockResolvedValue({ id: 'dp1' })
    mockGetPriceHistory.mockRejectedValue(new Error('relation "price_histories" does not exist'))

    const res = await GET(new Request('http://localhost') as never, { params })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain('relation')
    expect(body.error).not.toContain('price_histories')
    expect(body.error).toBe('価格履歴の取得に失敗しました')
  })

  it('翻訳済みのエラー（ClientVisibleError）はそのまま伝える（対照）', async () => {
    // WHY(C-021): 上のテストは「全部隠す」実装でも通る。**通したい向き**も測って初めて意味が出る
    authenticated()
    mockGetDistributorProduct.mockResolvedValue({ id: 'dp1' })
    mockGetPriceHistory.mockRejectedValue(new ClientVisibleError('価格履歴が多すぎます'))

    const res = await GET(new Request('http://localhost') as never, { params })

    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('価格履歴が多すぎます')
  })
})
