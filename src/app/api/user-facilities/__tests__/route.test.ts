import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockListUserFacilities = vi.fn()
const mockListFacilities = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/user-facilities/repository', () => ({
  listUserFacilities: (...args: unknown[]) => mockListUserFacilities(...args),
}))

vi.mock('@/lib/facilities/repository', () => ({
  listFacilities: (...args: unknown[]) => mockListFacilities(...args),
}))

const ALL_FACILITIES = [
  { id: 'f1', name: 'facility1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: 'facility2', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f3', name: 'facility3', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockListFacilities.mockResolvedValue(ALL_FACILITIES)
})

describe('GET /api/user-facilities', () => {
  it('未認証の場合は401を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  // WHY(issue #20統合): /orders(SET-F)が非adminに他施設を選択肢として見せてしまう
  // 不整合を防ぐための回帰テスト。非adminには所属施設のみが返ることを検証する
  it('非adminの場合は所属施設のみを返す（全施設は含めない）', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockResolveIsAdmin.mockResolvedValue(false)
    mockListUserFacilities.mockResolvedValue([
      { facilityId: 'f2', facilityName: 'facility2', role: 'staff' },
    ])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isAdmin).toBe(false)
    expect(body.facilities).toEqual([ALL_FACILITIES[1]])
  })

  it('adminの場合は全施設を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockResolveIsAdmin.mockResolvedValue(true)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isAdmin).toBe(true)
    expect(body.facilities).toEqual(ALL_FACILITIES)
    expect(mockListUserFacilities).not.toHaveBeenCalled()
  })

  it('所属施設が0件の非adminは空配列を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockResolveIsAdmin.mockResolvedValue(false)
    mockListUserFacilities.mockResolvedValue([])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.facilities).toEqual([])
  })

  it('例外発生時は500を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
    mockResolveIsAdmin.mockRejectedValue(new Error('DB error'))

    const res = await GET()
    expect(res.status).toBe(500)
  })
})
