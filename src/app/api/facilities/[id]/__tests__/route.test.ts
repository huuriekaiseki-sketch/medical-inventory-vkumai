import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, PUT } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockGetFacility = vi.fn()
const mockUpdateFacility = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/facilities/repository', () => ({
  getFacility: (...args: unknown[]) => mockGetFacility(...args),
  updateFacility: (...args: unknown[]) => mockUpdateFacility(...args),
}))

const context = { params: Promise.resolve({ id: 'f1' }) }
const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveIsAdmin.mockResolvedValue(true)
})

describe('GET /api/facilities/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockGetFacility).not.toHaveBeenCalled()
  })

  it('認証済みで正常に取得できる', async () => {
    authenticated()
    mockGetFacility.mockResolvedValue({ id: 'f1', name: '施設A' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/facilities/[id]', () => {
  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(401)
    expect(mockUpdateFacility).not.toHaveBeenCalled()
  })

  it('認証済みで正常に更新できる', async () => {
    authenticated()
    mockUpdateFacility.mockResolvedValue({ id: 'f1', name: 'x' })
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(200)
  })

  it('一般ユーザーの場合は403を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const req = new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })
    const res = await PUT(req as never, context)
    expect(res.status).toBe(403)
    expect(mockUpdateFacility).not.toHaveBeenCalled()
  })
})

// WHY(2026-09-08・E-055): DELETE は**使えない道だった**ので消した。
//      `facilities` には DELETE の RLS ポリシーが 1 つも無く、admin が叩いても 0 行になり、
//      実在する施設に 404「施設が見つかりません」を返していた。
//      ここは「戻ってきたら気づく」ための ratchet。**RLS のポリシーと一緒でなければ作らない。**
//      作り直すときはこのテストを消し、DELETE の RLS ポリシーを足す migration と
//      「誰が消せるか」の決定（docs/agents/design-questions.md）を同じ PR に入れること。
// WHY(リポジトリ側をここで見ない): このファイルは `@/lib/facilities/repository` をモックしているので、
//      ここから import しても本物の公開一覧は見えない。route の公開だけを見る。
describe('DELETE /api/facilities/[id] は無い（E-055）', () => {
  it('route が DELETE を公開していない', async () => {
    const route = await import('../route')
    expect(Object.keys(route).sort()).toEqual(['GET', 'PUT'])
  })
})

// WHY(#757-24 の残り、2026-09-13): RLS で見えない行は 404 のままだが、存在するなら拒否として残す。
//      route が固定するのは「0 件のときだけヘルパーを呼ぶ」「応答は 404 のまま」の 2 点
const { mockRecordHiddenRowDenial } = vi.hoisted(() => ({ mockRecordHiddenRowDenial: vi.fn() }))
vi.mock('@/lib/security/hidden-row-denial', () => ({
  recordHiddenRowDenial: (...args: unknown[]) => mockRecordHiddenRowDenial(...args),
}))

describe('GET /api/facilities/[id]: RLS で 0 件のとき [P-063]', () => {
  it('0 件なら 404 のまま、存在確認と記録のヘルパーを要求 ID と本人 ID で呼ぶ', async () => {
    authenticated()
    mockGetFacility.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(404)
    expect(mockRecordHiddenRowDenial).toHaveBeenCalledWith({ table: 'facilities', id: 'f1', actorId: 'u1' })
  })

  it('見つかればヘルパーは呼ばない', async () => {
    authenticated()
    mockGetFacility.mockResolvedValue({ id: 'f1', name: '施設' })
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(200)
    expect(mockRecordHiddenRowDenial).not.toHaveBeenCalled()
  })

  it('未認証ならヘルパーを呼ばない（誰の拒否か分からない記録を作らない）', async () => {
    unauthenticated()
    const res = await GET(new Request('http://localhost') as never, context)
    expect(res.status).toBe(401)
    expect(mockRecordHiddenRowDenial).not.toHaveBeenCalled()
  })
})
