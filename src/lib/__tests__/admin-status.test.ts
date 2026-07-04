// WHY: resolveIsAdmin()が「①自分がrole='admin'か→②DB全体にadminが1件でもいるか
//      →③いなければADMIN_EMAILSフォールバック」の判定を、SECURITY DEFINER RPC
//      (get_admin_status)経由で正しく行うことを保証する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { resolveIsAdmin } from '@/lib/admin-status'

const USER_ID = 'user-123'

function makeUser(id: string, email: string): User {
  return { id, email } as User
}

function makeDb(data: unknown, error: Error | null = null): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error }),
  } as unknown as SupabaseClient
}

describe('resolveIsAdmin', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails
  })

  it('自分がadminならtrueを返す', async () => {
    const db = makeDb([{ user_is_admin: true, db_has_admin: true }])
    const user = makeUser(USER_ID, 'user@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(true)
    expect(db.rpc).toHaveBeenCalledWith('get_admin_status', { p_user_id: USER_ID })
  })

  it('自分はadminでないが他にadminがいる場合はfalseを返す', async () => {
    const db = makeDb([{ user_is_admin: false, db_has_admin: true }])
    const user = makeUser(USER_ID, 'user@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  it('DBにadmin0件でADMIN_EMAILSに一致すればtrueを返す', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com'
    const db = makeDb([{ user_is_admin: false, db_has_admin: false }])
    const user = makeUser(USER_ID, 'admin@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(true)
  })

  it('DBにadmin0件でADMIN_EMAILSに一致しなければfalseを返す', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com'
    const db = makeDb([{ user_is_admin: false, db_has_admin: false }])
    const user = makeUser(USER_ID, 'other@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  it('ADMIN_EMAILSが未設定でDBにadmin0件ならfalseを返す', async () => {
    delete process.env.ADMIN_EMAILS
    const db = makeDb([{ user_is_admin: false, db_has_admin: false }])
    const user = makeUser(USER_ID, 'user@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  it('RPCエラー時はfalseを返す', async () => {
    const db = makeDb(null, new Error('rpc error'))
    const user = makeUser(USER_ID, 'admin@example.com')
    process.env.ADMIN_EMAILS = 'admin@example.com'

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  it('RPCがdataなし(空配列)のときfalseを返す', async () => {
    const db = makeDb([])
    const user = makeUser(USER_ID, 'admin@example.com')
    process.env.ADMIN_EMAILS = 'admin@example.com'

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })
})
