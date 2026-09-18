// WHY: resolveIsAdmin()が「①自分がrole='admin'か→②DB全体にadminが1件でもいるか
//      →③いなければADMIN_EMAILSフォールバック」の判定を、SECURITY DEFINER RPC
//      (get_admin_status)経由で正しく行うことを保証する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { resolveIsAdmin } from '@/lib/admin-status'
import { AUTH_JUDGMENT_TIMEOUT_MS } from '@/lib/security/judgment-timeout'

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
    expect(db.rpc).toHaveBeenCalledWith('get_admin_status')
  })

  it('自分はadminでないが他にadminがいる場合はfalseを返す', async () => {
    // WHY(2026-09-07 のミューテーション計測): ここで ADMIN_EMAILS を**自分のメール**に
    //      設定するのが要点。以前は未設定で書かれていたため、`if (db_has_admin) return false`
    //      を丸ごと消しても、後ろの ADMIN_EMAILS フォールバックがどのみち false を返して
    //      テストが通っていた。フォールバックは「DB にまだ一人も admin がいないとき」だけの
    //      非常口であって、admin が存在する運用では効いてはいけない。
    //      この一行が無いと「DB に admin がいるのに ADMIN_EMAILS 掲載者も admin になれる」
    //      に化けても気づけない。
    process.env.ADMIN_EMAILS = 'user@example.com'
    const db = makeDb([{ user_is_admin: false, db_has_admin: true }])
    const user = makeUser(USER_ID, 'user@example.com')

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  // WHY: ADMIN_EMAILS は人が手で書く環境変数なので、空白・大文字・末尾のカンマが混ざる。
  //      その正規化（trim / toLowerCase / filter(Boolean)）を外しても全テストが通っていた。
  //      外れると「設定したのに admin になれない」（締め出し）と
  //      「空文字が一致して誰でも admin になる」の両方が起きうる。
  describe('ADMIN_EMAILS の正規化（DB に admin が 0 件のときだけ効く非常口）', () => {
    const dbNoAdmin = () => makeDb([{ user_is_admin: false, db_has_admin: false }])

    it('前後の空白を落として比較する', async () => {
      process.env.ADMIN_EMAILS = '  admin@example.com  ,  other@example.com  '
      expect(await resolveIsAdmin(dbNoAdmin(), makeUser(USER_ID, 'admin@example.com'))).toBe(true)
    })

    it('大文字小文字を無視して比較する（設定側・利用者側の両方）', async () => {
      process.env.ADMIN_EMAILS = 'Admin@Example.COM'
      expect(await resolveIsAdmin(dbNoAdmin(), makeUser(USER_ID, 'ADMIN@example.com'))).toBe(true)
    })

    it('利用者のメールの前後の空白も落とす', async () => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      expect(await resolveIsAdmin(dbNoAdmin(), makeUser(USER_ID, ' admin@example.com '))).toBe(true)
    })

    it('空の要素（末尾のカンマ・カンマだけ）は誰にも一致しない', async () => {
      // メールを持たない利用者が空文字と一致して admin になる事故を防ぐ
      process.env.ADMIN_EMAILS = ',, ,'
      const noEmail = { id: USER_ID } as User
      expect(await resolveIsAdmin(dbNoAdmin(), noEmail)).toBe(false)
      expect(await resolveIsAdmin(dbNoAdmin(), makeUser(USER_ID, ''))).toBe(false)
    })

    it('メールを持たない利用者は一致しない', async () => {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      const noEmail = { id: USER_ID } as User
      expect(await resolveIsAdmin(dbNoAdmin(), noEmail)).toBe(false)
    })
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

  it('error と data が同時に返っても data を信じない', async () => {
    // WHY(2026-09-07 のミューテーション計測): `if (error || !data || ...)` を
    //      `if (error && !data || ...)` に書き換えても全テストが通っていた。
    //      「エラー時は data が null」しか測っていなかったため。
    //      `&&` になると、RPC がエラーと一緒に行を返す形になったときに
    //      **その行の user_is_admin を信じて admin を通してしまう**。
    //      判定できないときは admin にしない（fail-closed）。
    process.env.ADMIN_EMAILS = 'admin@example.com'
    const db = makeDb([{ user_is_admin: true, db_has_admin: true }], new Error('rpc error'))
    const user = makeUser(USER_ID, 'user@example.com')

    expect(await resolveIsAdmin(db, user)).toBe(false)
  })

  it('RPCがdataなし(空配列)のときfalseを返す', async () => {
    const db = makeDb([])
    const user = makeUser(USER_ID, 'admin@example.com')
    process.env.ADMIN_EMAILS = 'admin@example.com'

    const result = await resolveIsAdmin(db, user)
    expect(result).toBe(false)
  })

  // WHY(#757-31): PostgREST を止めた実測で、この RPC が **75 秒**返らなかった。
  //      上限で諦めたときに admin を通すと、依存が落ちている間だけ全施設に届く。
  //      「返ってこない」は「材料が取れない」なので非 admin に倒す
  it('RPC が返ってこないときは上限で諦めて false を返す（依存が落ちている間だけ admin にならない）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      process.env.ADMIN_EMAILS = 'admin@example.com'
      const db = { rpc: vi.fn(() => new Promise(() => {})) } as unknown as SupabaseClient
      const promise = resolveIsAdmin(db, makeUser(USER_ID, 'admin@example.com'))
      await vi.advanceTimersByTimeAsync(AUTH_JUDGMENT_TIMEOUT_MS)
      expect(await promise).toBe(false)
      // WHY(どの判定が諦めたかまで見る): 「judgment-timeout」だけを見ていると、
      //      呼び出し側のラベルを空文字に書き換えても緑のままだった（2026-09-08 の変異計測）。
      //      ログに出るのが「何かが諦めた」だけになると、原因の切り分けができない
      const printed = JSON.stringify(spy.mock.calls)
      expect(printed).toContain('judgment-timeout')
      expect(printed).toContain('rpc.get_admin_status')
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})
