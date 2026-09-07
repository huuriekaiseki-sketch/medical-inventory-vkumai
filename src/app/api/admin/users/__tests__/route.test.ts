import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockListUsers = vi.fn()
const mockInviteUserByEmail = vi.fn()
const mockDeleteUser = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({
    auth: {
      admin: {
        listUsers: mockListUsers,
        inviteUserByEmail: mockInviteUserByEmail,
        deleteUser: mockDeleteUser,
      },
    },
    from: mockFrom,
  }),
  createServerSupabase: () => ({
    auth: { getUser: mockGetUser },
  }),
}))

const mockConsumeInviteQuota = vi.fn(async () => ({
  allowed: true, hitCount: 1, limit: 50, resetAt: null, unmeasured: false,
}))
// WHY(Q-020・M-021): 差し替えるのは consumeInviteQuota だけにし、**それ以外の名前を
//      route が呼んだら即座に落とす**。「送信に失敗したら枠を戻す」を後から足すときは、
//      払い戻し用の別の関数がここに現れる。呼ばれた回数だけを見ていると、
//      別名の関数が増えてもテストは緑のままになる（見えない変更になる）。
vi.mock('@/lib/security/rate-limit', () => new Proxy(
  { consumeInviteQuota: (...args: unknown[]) => mockConsumeInviteQuota(...(args as [])) },
  {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined
      throw new Error(`rate-limit の未知の関数を呼んでいる: ${String(prop)}（Q-020 の数え方が変わった）`)
    },
  },
))

// WHY(2026-09-07、W-011): 特権操作の直前に admin と aal2 を再確認する
//      `assertAdminAal2` を足した。既定は true（MFA 未登録の運用は変わらない）で、
//      個別のテストで false に差し替えて 403 を確かめる。
const mockAssertAdminAal2 = vi.fn(async () => true)

// WHY(2026-09-07、#757-24・39): 特権操作の記録。監査トリガーは public スキーマにしか付かず
//      auth.users には届かないので、成功した招待・削除がどこにも残っていなかった。
//      **route が実際に記録を呼ぶこと**をここで固定する（呼ばなくなっても気づけるように）。
const mockRecordPrivilegedOperation = vi.fn(async () => {})

vi.mock('@/lib/security/privileged-operation', async (importOriginal) => ({
  // toOperationErrorCode は純粋関数なので本物を使う（記録に残る文字列まで route の性質として測る）
  ...(await importOriginal<typeof import('@/lib/security/privileged-operation')>()),
  recordPrivilegedOperation: (...args: unknown[]) => mockRecordPrivilegedOperation(...(args as [])),
}))

vi.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    const result = await mockGetUser()
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
    const email = result?.data?.user?.email?.trim().toLowerCase() ?? ''
    if (!result?.data?.user || !adminEmails.includes(email)) return null
    return result.data.user
  },
  assertAdminAal2: (...args: unknown[]) => mockAssertAdminAal2(...(args as [])),
}))

const ADMIN_EMAIL = 'admin@test.com'
const ADMIN_ID = 'admin-user-id'

beforeEach(() => {
  vi.clearAllMocks()
  mockAssertAdminAal2.mockResolvedValue(true)
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { id: ADMIN_ID, email: ADMIN_EMAIL } },
  })
})

describe('GET /api/admin/users', () => {
  it('ユーザー一覧と担当施設IDを返す（バルク取得）', async () => {
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          { id: 'u1', email: 'a@test.com', last_sign_in_at: '2026-06-27T00:00:00Z' },
          { id: 'u2', email: 'b@test.com', last_sign_in_at: null },
        ],
      },
      error: null,
    })
    const mockIn = vi.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', facility_id: 'f1', role: 'admin' },
        { user_id: 'u1', facility_id: 'f2', role: 'staff' },
      ],
      error: null,
    })
    const mockSelect = vi.fn().mockReturnValue({ in: mockIn })
    mockFrom.mockReturnValue({ select: mockSelect })

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockSelect).toHaveBeenCalledWith('user_id, facility_id, role')
    expect(mockIn).toHaveBeenCalledWith('user_id', ['u1', 'u2'])
    expect(body.users[0].id).toBe('u1')
    expect(body.users[0].facilities).toEqual([
      { id: 'f1', role: 'admin' },
      { id: 'f2', role: 'staff' },
    ])
    expect(body.users[1].facilities).toEqual([])
  })

  // WHY(#757-32): listUsers() は既定で 1 ページ 50 件しか返さない。全ページを取り切らないと
  //      51 人目から画面にも API にも出ない（2026-09-07 に 60 人作って実測）。
  it('利用者が 1 ページに収まらないときも全員を返す（ページを取り切る）', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID, email: ADMIN_EMAIL } } })
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `u-${i}`,
      email: `u${i}@example.test`,
      last_sign_in_at: null,
    }))
    const page2 = [{ id: 'u-1000', email: 'u1000@example.test', last_sign_in_at: null }]
    mockListUsers
      .mockResolvedValueOnce({ data: { users: page1 }, error: null })
      .mockResolvedValueOnce({ data: { users: page2 }, error: null })
    mockFrom.mockReturnValue({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
    })

    const res = await GET()
    const body = await res.json()

    expect(mockListUsers).toHaveBeenCalledTimes(2)
    expect(mockListUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 1000 })
    expect(mockListUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 })
    expect(body.users).toHaveLength(1001)
    expect(body.users.at(-1).id).toBe('u-1000')
  })

  it('2 ページ目の取得が失敗したら 500 を返す（黙って途中まで返さない）', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID, email: ADMIN_EMAIL } } })
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `x-${i}`, email: `x${i}@example.test`, last_sign_in_at: null }))
    mockListUsers
      .mockResolvedValueOnce({ data: { users: page1 }, error: null })
      .mockResolvedValueOnce({ data: { users: [] }, error: { message: 'boom' } })

    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('DBのroleが想定外の値の場合はstaffにフォールバックする', async () => {
    mockListUsers.mockResolvedValue({
      data: { users: [{ id: 'u1', email: 'a@test.com', last_sign_in_at: null }] },
      error: null,
    })
    const mockIn = vi.fn().mockResolvedValue({
      data: [{ user_id: 'u1', facility_id: 'f1', role: 'superadmin' }],
      error: null,
    })
    const mockSelect = vi.fn().mockReturnValue({ in: mockIn })
    mockFrom.mockReturnValue({ select: mockSelect })

    const res = await GET()
    const body = await res.json()

    expect(body.users[0].facilities).toEqual([{ id: 'f1', role: 'staff' }])
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/users', () => {
  it('招待メールを送信して 200 を返す', async () => {
    mockInviteUserByEmail.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@test.com' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInviteUserByEmail).toHaveBeenCalledWith('new@test.com')
  })

  // WHY(#757-32 Q-020): 招待メールは外へ出ていく唯一の経路。上限を超えたら**送らずに**
  //      429 を返す（人の回答「拒否して記録に残す」）。記録は access_denials 側で確かめる
  it('1 日の上限を超えたら送らずに 429 を返す', async () => {
    mockInviteUserByEmail.mockResolvedValue({ error: null })
    mockConsumeInviteQuota.mockResolvedValueOnce({
      allowed: false, hitCount: 51, limit: 50, resetAt: null, unmeasured: false,
    })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'over@test.com' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(429)
    expect(mockInviteUserByEmail).not.toHaveBeenCalledWith('over@test.com')
  })

  it('email 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/users', () => {
  it('ユーザーを削除して 200 を返す', async () => {
    mockDeleteUser.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(mockDeleteUser).toHaveBeenCalledWith('u1')
  })

  it('userId 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({}),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it('自分自身の削除は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: ADMIN_ID }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('自分自身は削除できません')
  })
})

// WHY(W-011): Supabase Auth の管理 API は service_role でしか呼べず、RLS のトランザクションに
//      統合できない。隙間を消せないので、特権操作の**直前**にもう一度確かめて窓を狭めている。
//      その再確認が実際に効いていること（＝ Auth API を呼ぶ前に止まること）を固定する。
describe('特権操作の直前の再確認（W-011）', () => {
  it('aal2 でなければ招待メールを送らずに 403 を返す', async () => {
    mockAssertAdminAal2.mockResolvedValue(false)
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@example.test' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(mockInviteUserByEmail).not.toHaveBeenCalled()
  })

  it('aal2 でなければ利用者を削除せずに 403 を返す', async () => {
    mockAssertAdminAal2.mockResolvedValue(false)
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(403)
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})

// 約束カタログ（docs/agents/promise-catalog.md）: P-066 特権操作は成功も失敗も記録に残る
describe('特権操作の記録 [P-066]', () => {
  const req = (method: string, body: unknown) =>
    new NextRequest('http://localhost/api/admin/users', { method, body: JSON.stringify(body) })

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ADMIN_EMAILS = 'admin@test.com'
    mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1', email: 'admin@test.com' } } })
    mockConsumeInviteQuota.mockResolvedValue({ allowed: true, hitCount: 1, limit: 50, resetAt: null, unmeasured: false })
    mockAssertAdminAal2.mockResolvedValue(true)
  })

  it('招待が成功したら succeeded=true とメールを記録する', async () => {
    mockInviteUserByEmail.mockResolvedValue({ error: null })
    const res = await POST(req('POST', { email: 'new@test.com' }))
    expect(res.status).toBe(200)
    expect(mockRecordPrivilegedOperation).toHaveBeenCalledWith({
      operation: 'user_invite',
      succeeded: true,
      actorId: 'admin-1',
      targetEmail: 'new@test.com',
      errorCode: null,
    })
  })

  it('招待が失敗しても記録する（succeeded=false と code）', async () => {
    // WHY: 失敗だけ・成功だけのどちらか一方しか残さないと、乗っ取り後に
    //      「何を試して何が通ったか」の片側が欠ける
    mockInviteUserByEmail.mockResolvedValue({ error: { message: 'boom', code: 'email_exists' } })
    await POST(req('POST', { email: 'dup@test.com' }))
    expect(mockRecordPrivilegedOperation).toHaveBeenCalledWith({
      operation: 'user_invite',
      succeeded: false,
      actorId: 'admin-1',
      targetEmail: 'dup@test.com',
      errorCode: 'email_exists',
    })
  })

  it('削除が成功したら succeeded=true と対象の利用者 ID を記録する', async () => {
    mockDeleteUser.mockResolvedValue({ error: null })
    const res = await DELETE(req('DELETE', { userId: 'victim-1' }))
    expect(res.status).toBe(200)
    expect(mockRecordPrivilegedOperation).toHaveBeenCalledWith({
      operation: 'user_delete',
      succeeded: true,
      actorId: 'admin-1',
      targetUserId: 'victim-1',
      errorCode: null,
    })
  })

  it('削除が失敗しても記録する', async () => {
    mockDeleteUser.mockResolvedValue({ error: { message: 'nope', code: 'user_not_found' } })
    await DELETE(req('DELETE', { userId: 'ghost' }))
    expect(mockRecordPrivilegedOperation).toHaveBeenCalledWith({
      operation: 'user_delete',
      succeeded: false,
      actorId: 'admin-1',
      targetUserId: 'ghost',
      errorCode: 'user_not_found',
    })
  })

  it('aal2 で弾かれたときは Auth を呼ばないので記録もしない（拒否は access_denials 側）', async () => {
    // WHY: 弾かれた分は assertAdminAal2 が access_denials に残す。両方に書くと二重計上になる
    mockAssertAdminAal2.mockResolvedValue(false)
    const res = await POST(req('POST', { email: 'blocked@test.com' }))
    expect(res.status).toBe(403)
    expect(mockInviteUserByEmail).not.toHaveBeenCalled()
    expect(mockRecordPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('上限で弾かれたときも記録しない（メールを送っていないので特権操作が起きていない）', async () => {
    mockConsumeInviteQuota.mockResolvedValue({ allowed: false, hitCount: 51, limit: 50, resetAt: null, unmeasured: false })
    const res = await POST(req('POST', { email: 'over@test.com' }))
    expect(res.status).toBe(429)
    expect(mockRecordPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('SMTP 障害のように code が無い失敗でも、理由が記録に残る（http_500）', async () => {
    // WHY(M-021 の実測、2026-09-07): ローカルの SMTP を止めて招待すると GoTrue は
    //      status 500 / message "Error sending invite email" を返すが **code は付かない**。
    //      code だけを残していた頃は、記録を見ても「メールが出せなかった」のか
    //      「既に登録済み」なのか区別できなかった
    mockInviteUserByEmail.mockResolvedValue({ error: { message: 'Error sending invite email', status: 500 } })
    await POST(req('POST', { email: 'smtp-down@test.com' }))
    expect(mockRecordPrivilegedOperation).toHaveBeenCalledWith({
      operation: 'user_invite',
      succeeded: false,
      actorId: 'admin-1',
      targetEmail: 'smtp-down@test.com',
      errorCode: 'http_500',
    })
  })
})

// 割り当ての棚卸し（docs/agents/quota-inventory.md）: Q-020 招待メールは送る前に数える
describe('招待の回数制限を数える順番 [Q-020]', () => {
  const req = (body: unknown) =>
    new NextRequest('http://localhost/api/admin/users', { method: 'POST', body: JSON.stringify(body) })

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ADMIN_EMAILS = 'admin@test.com'
    mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1', email: 'admin@test.com' } } })
    mockAssertAdminAal2.mockResolvedValue(true)
  })

  // WHY: 送ってしまったメールは取り消せないので、数えるのは必ず送信より前でなければならない。
  //      順番が入れ替わると「51 通目を送ってから 429 を返す」になり、上限が守れていない状態で
  //      テストは緑のままになる（呼ばれた回数だけを見ていると気づけない形）
  it.each([
    ['成功したとき', { error: null }],
    ['メール送信が失敗したとき', { error: { message: 'Error sending invite email', status: 500 } }],
  ])('%s も、消費（consumeInviteQuota）は送信より先に起きる', async (_label, inviteResult) => {
    const order: string[] = []
    mockConsumeInviteQuota.mockImplementation(async () => {
      order.push('quota')
      return { allowed: true, hitCount: 1, limit: 50, resetAt: null, unmeasured: false }
    })
    mockInviteUserByEmail.mockImplementation(async () => {
      order.push('invite')
      return inviteResult
    })

    await POST(req({ email: 'order@test.com' }))

    expect(order).toEqual(['quota', 'invite'])
  })

  it('メール送信に失敗しても消費は取り消されない（枠だけが減る。#757-38 で戻すかを決める）', async () => {
    // WHY(M-021 の実測、2026-09-07): SMTP を止めると GoTrue は利用者行ごとロールバックするので、
    //      auth 側には何も残らない。**残るのはこの枠だけ**で、SMTP 障害中に押し直すと
    //      メールが 1 通も出ないまま 1 日 50 通の枠が減っていく。
    //      いま戻していないことを固定する。戻す実装を足すと、上の Proxy が
    //      「rate-limit の未知の関数」で落ちる（同じモジュールに払い戻しが増えるため）
    mockConsumeInviteQuota.mockResolvedValue({ allowed: true, hitCount: 1, limit: 50, resetAt: null, unmeasured: false })
    mockInviteUserByEmail.mockResolvedValue({ error: { message: 'Error sending invite email', status: 500 } })

    await POST(req({ email: 'smtp-down@test.com' }))

    expect(mockConsumeInviteQuota).toHaveBeenCalledTimes(1)
    expect(mockConsumeInviteQuota).toHaveBeenCalledWith('admin-1')
  })
})
