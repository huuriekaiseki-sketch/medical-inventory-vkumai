import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListNewsFeed = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/news/repository', () => ({
  listNewsFeed: (...args: unknown[]) => mockListNewsFeed(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockListNewsFeed.mockResolvedValue([])
})

describe('GET /api/news', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1'))
    expect(res.status).toBe(401)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('facilityId未指定・非adminの場合は400を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FACILITY_ID_REQUIRED'))
    const res = await GET(new NextRequest('http://localhost/api/news'))
    expect(res.status).toBe(400)
  })

  it('未所属施設を指定した場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f9'))
    expect(res.status).toBe(403)
  })

  it('正常系: 認可済みfacilityId・limit・offsetでlistNewsFeedを呼びitemsを返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
    mockListNewsFeed.mockResolvedValue([{ id: 'n1', eventType: 'new_product' }])

    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=5&offset=10'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([{ id: 'n1', eventType: 'new_product' }])
    expect(mockListNewsFeed).toHaveBeenCalledWith(expect.anything(), { facilityId: 'f1', limit: 5, offset: 10 })
  })

  it('limit/offset省略時はデフォルト値(20, 0)を使う', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1'))
    expect(res.status).toBe(200)
    expect(mockListNewsFeed).toHaveBeenCalledWith(expect.anything(), { facilityId: 'f1', limit: 20, offset: 0 })
  })

  it('例外発生時は500を返す', async () => {
    authenticated()
    mockListNewsFeed.mockRejectedValue(new Error('DB error'))
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1'))
    expect(res.status).toBe(500)
  })

  it('limit が不正値(abc)の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=abc'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('offset が不正値(xyz)の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&offset=xyz'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('limit が負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=-1'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('offset が負数の場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&offset=-5'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('limit=0 は有効な値として受け入れる', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=0&offset=0'))
    expect(res.status).toBe(200)
    expect(mockListNewsFeed).toHaveBeenCalledWith(expect.anything(), { facilityId: 'f1', limit: 0, offset: 0 })
  })

  // WHY(2026-09-09、E-053 の実害): この route は limit を独自に検証していて、
  //      共通の parsePagination と条件が食い違っていた。あちらは Number.isInteger で小数を弾くが、
  //      こちらは Number.isFinite だったので **1.5 がそのまま listNewsFeed へ渡っていた**
  //      （DB の LIMIT は整数しか受けない）。判定を共有スキーマへ寄せて塞いだ。
  it('limit が小数(1.5)の場合は400を返す（判定を共有スキーマへ寄せる前は素通りしていた）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=1.5'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('offset が小数(2.5)の場合も400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&offset=2.5'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  // WHY(パラメータ汚染): `get()` は先頭だけを返すので、2 つ目が黙って捨てられる。
  //      層ごとに採る側が違うと境界の検査をすり抜ける道になりうるので、受け取らない
  it('同じ鍵を 2 回渡すと400を返す（先頭だけを黙って採らない）', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=1&limit=99'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('limit が上限(100)を超える場合は400を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=101'))
    expect(res.status).toBe(400)
    expect(mockListNewsFeed).not.toHaveBeenCalled()
  })

  it('limit が上限ちょうど(100)の場合は200を返す', async () => {
    authenticated()
    const res = await GET(new NextRequest('http://localhost/api/news?facilityId=f1&limit=100'))
    expect(res.status).toBe(200)
    expect(mockListNewsFeed).toHaveBeenCalledWith(expect.anything(), { facilityId: 'f1', limit: 100, offset: 0 })
  })

  it('admin・facilityId省略時は全施設データが返る（issue #40）', async () => {
    authenticated()
    mockRequireFacilityAccess.mockResolvedValue({ facilityId: null })
    mockListNewsFeed.mockResolvedValue([
      { id: 'n1', eventType: 'new_product', facilityName: '施設A' },
      { id: 'n2', eventType: 'new_product', facilityName: '施設B' },
    ])

    const res = await GET(new NextRequest('http://localhost/api/news'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(mockListNewsFeed).toHaveBeenCalledWith(expect.anything(), { facilityId: null, limit: 20, offset: 0 })
  })
})
