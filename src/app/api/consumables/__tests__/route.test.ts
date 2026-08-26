import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../route'
import { ClientVisibleError } from '@/lib/client-visible-error'

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockListConsumablesByFacility = vi.fn()
const mockCreateConsumable = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))

vi.mock('@/lib/consumables/repository', () => ({
  listConsumablesByFacility: (...args: unknown[]) => mockListConsumablesByFacility(...args),
  createConsumable: (...args: unknown[]) => mockCreateConsumable(...args),
}))

const unauthenticated = () => mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () => mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

const validBody = { facilityId: 'f1', name: '品名', jan: '123', purpose: '用途' }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
})

describe('POST /api/consumables', () => {
  // 受け入れ条件「品名・用途が空白のみの場合は400エラーになる」はUI側の事前バリデーション
  // だけでなく、API自体が実際に400を返すことをここで担保する(issue #647 レビュー指摘対応)。
  it('品名が空白のみの場合は400を返す', async () => {
    authenticated()
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, name: '   ' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  it('用途が空白のみの場合は400を返す', async () => {
    authenticated()
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, purpose: '   ' }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  it('未認証の場合は401を返す', async () => {
    unauthenticated()
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(401)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  it('施設アクセス権がない場合は403を返す', async () => {
    authenticated()
    mockRequireFacilityAccess.mockRejectedValue(new Error('FORBIDDEN'))
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(403)
    expect(mockCreateConsumable).not.toHaveBeenCalled()
  })

  // consumables.jan は products(jan) への FK(20260714000004)。存在しないJANを指定した場合、
  // repository層が投げるClientVisibleErrorをAPIが400として返すことを担保する
  // (issue #647 レビュー指摘: FK違反時に汎用500になっていた境界条件の未カバー)。
  it('存在しないJANを指定した場合はDB FK違反により400を返す', async () => {
    authenticated()
    mockCreateConsumable.mockRejectedValue(new ClientVisibleError('指定されたJANコードの製品が見つかりません'))
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('指定されたJANコードの製品が見つかりません')
  })

  it('認証済み・アクセス権ありで正常に作成できる', async () => {
    authenticated()
    mockCreateConsumable.mockResolvedValue({ id: 'c1', ...validBody })
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify(validBody) })
    const res = await POST(req as never)
    expect(res.status).toBe(201)
    expect(mockRequireFacilityAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'f1')
  })
})
