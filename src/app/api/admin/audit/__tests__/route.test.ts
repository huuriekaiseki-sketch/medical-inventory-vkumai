import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

// WHY: issue #757 の 4・24。監査ログの窓口。ここで確かめるのは境界と入力の検証で、
//      「誰が読めるか」自体は RLS と統合テストが守る（P-061 / P-063）。

const mockGetUser = vi.fn()
const mockResolveIsAdmin = vi.fn()
const mockListAuditLog = vi.fn()
const mockListAccessDenials = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({ auth: { getUser: mockGetUser } }),
}))

vi.mock('@/lib/admin-status', () => ({
  resolveIsAdmin: (...args: unknown[]) => mockResolveIsAdmin(...args),
}))

vi.mock('@/lib/audit/repository', () => ({
  listAuditLog: (...args: unknown[]) => mockListAuditLog(...args),
  listAccessDenials: (...args: unknown[]) => mockListAccessDenials(...args),
}))

const unauthenticated = () =>
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
const authenticated = () =>
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })

function get(url: string) {
  return GET(new NextRequest(url))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListAuditLog.mockResolvedValue([])
  mockListAccessDenials.mockResolvedValue([])
})

describe('GET /api/admin/audit', () => {
  it('未認証は 401 で、記録を 1 行も読みに行かない', async () => {
    unauthenticated()
    const res = await get('http://localhost/api/admin/audit')
    expect(res.status).toBe(401)
    expect(mockListAuditLog).not.toHaveBeenCalled()
  })

  it('admin でなければ 403 で、記録を 1 行も読みに行かない', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(false)
    const res = await get('http://localhost/api/admin/audit')
    expect(res.status).toBe(403)
    expect(mockListAuditLog).not.toHaveBeenCalled()
    expect(mockListAccessDenials).not.toHaveBeenCalled()
  })

  it('既定は変更の記録を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await get('http://localhost/api/admin/audit')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kind).toBe('changes')
    expect(mockListAuditLog).toHaveBeenCalledTimes(1)
    expect(mockListAccessDenials).not.toHaveBeenCalled()
  })

  it('kind=denials では拒否の記録を返す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await get('http://localhost/api/admin/audit?kind=denials')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kind).toBe('denials')
    expect(mockListAccessDenials).toHaveBeenCalledTimes(1)
    expect(mockListAuditLog).not.toHaveBeenCalled()
  })

  it('知らない kind は 400', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    const res = await get('http://localhost/api/admin/audit?kind=everything')
    expect(res.status).toBe(400)
    expect(mockListAuditLog).not.toHaveBeenCalled()
  })

  it('日付の形式と前後関係を検証する', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    expect((await get('http://localhost/api/admin/audit?date_from=abc')).status).toBe(400)
    expect((await get('http://localhost/api/admin/audit?date_to=2026-13-01')).status).toBe(400)
    expect(
      (await get('http://localhost/api/admin/audit?date_from=2026-09-10&date_to=2026-09-01')).status
    ).toBe(400)
    expect(mockListAuditLog).not.toHaveBeenCalled()
  })

  it('件数の上限は共通のもの（1〜200）に従う', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    expect((await get('http://localhost/api/admin/audit?limit=201')).status).toBe(400)
    expect((await get('http://localhost/api/admin/audit?limit=0')).status).toBe(400)
    expect(mockListAuditLog).not.toHaveBeenCalled()

    const res = await get('http://localhost/api/admin/audit?limit=200&offset=10')
    expect(res.status).toBe(200)
    expect(mockListAuditLog.mock.calls[0][1]).toMatchObject({ limit: 200, offset: 10 })
  })

  it('絞り込みの条件をそのまま渡す', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    await get(
      'http://localhost/api/admin/audit?kind=denials&facility_id=f1&actor_id=a1&guard=facility&date_from=2026-09-01&date_to=2026-09-07'
    )
    expect(mockListAccessDenials.mock.calls[0][1]).toMatchObject({
      kind: 'denials',
      facilityId: 'f1',
      actorId: 'a1',
      guard: 'facility',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-07',
    })
  })

  it('権限のエラーが漏れてきたら 500 で隠さず 403 にする', async () => {
    authenticated()
    mockResolveIsAdmin.mockResolvedValue(true)
    mockListAuditLog.mockRejectedValue(new Error('permission denied for table audit_log'))
    const res = await get('http://localhost/api/admin/audit')
    expect(res.status).toBe(403)
  })
})
