// WHY: issue #757 の 24・39（P-066）。記録ヘルパーの性質を DB 無しで固定する。
//      確かめるのは 3 つ:
//        - 渡した内容が RPC にそのまま渡る（語彙・PII の扱いが途中で変わらない）
//        - 記録の失敗で特権操作を止めない（例外を投げない）
//        - **ただし黙らない**（PostgREST の失敗は戻り値の error に来るので、捨てると誰も気づけない。
//          2026-09-07 に access-denial.ts で実際に起きた形）

import { beforeEach, describe, expect, it, vi } from 'vitest'
import limitsConfig from '../../../../aidd.config.json'

const rpc = vi.fn()
const createClient = vi.fn(() => ({ rpc }))
const headersGet = vi.fn()
const headers = vi.fn(async () => ({ get: headersGet }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}))
vi.mock('next/headers', () => ({
  headers: () => headers(),
}))

async function loadModule() {
  vi.resetModules()
  return import('../privileged-operation')
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-066 特権操作は成功も失敗も記録に残る
describe('特権操作の記録ヘルパー（recordPrivilegedOperation） [P-066]', () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null })
    createClient.mockClear()
    headersGet.mockReset().mockReturnValue(null)
    headers.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  it('招待の成功をそのまま RPC に渡す', async () => {
    const m = await loadModule()
    await m.recordPrivilegedOperation({
      operation: 'user_invite',
      succeeded: true,
      actorId: 'admin-1',
      targetEmail: 'new@example.com',
    })
    expect(rpc).toHaveBeenCalledWith('record_privileged_operation', {
      p_operation: 'user_invite',
      p_succeeded: true,
      p_actor_id: 'admin-1',
      p_target_email: 'new@example.com',
      p_target_user_id: undefined,
      p_error_code: undefined,
      p_route: undefined,
      p_method: undefined,
    })
  })

  it('削除の失敗も code つきで渡す（成功だけ残さない）', async () => {
    const m = await loadModule()
    await m.recordPrivilegedOperation({
      operation: 'user_delete',
      succeeded: false,
      actorId: 'admin-1',
      targetUserId: 'victim-1',
      errorCode: 'user_not_found',
    })
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_operation: 'user_delete',
      p_succeeded: false,
      p_target_user_id: 'victim-1',
      p_error_code: 'user_not_found',
    })
  })

  it('経路は proxy が付けたヘッダから取る', async () => {
    headersGet.mockImplementation((name: string) =>
      name === 'x-aidd-route' ? '/api/admin/users' : name === 'x-aidd-method' ? 'POST' : null,
    )
    const m = await loadModule()
    await m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' })
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_route: '/api/admin/users',
      p_method: 'POST',
    })
  })

  it('ヘッダが読めない実行環境（Route Handler の外）でも記録は続く', async () => {
    headers.mockRejectedValueOnce(new Error('headers() outside request scope'))
    const m = await loadModule()
    await expect(
      m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' }),
    ).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('service role の環境変数が無ければ記録しない（例外も投げない）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const m = await loadModule()
    await expect(
      m.recordPrivilegedOperation({ operation: 'user_delete', succeeded: true, actorId: 'a' }),
    ).resolves.toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  // WHY(issue #793): ここは 2026-09-19 まで**黙って落ちていた**。上の「記録しない」だけを
  //      固定していたので、ログが無いことに誰も気づけなかった。特権操作（招待・削除）の記録が
  //      設定漏れのときは痕跡を残さず消える状態だった。「記録しない」と「黙らない」を対で固定する。
  it('env 未設定時は初回だけ警告ログが出る（黙って落とさない。issue #793）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const m = await loadModule()

      await m.recordPrivilegedOperation({ operation: 'user_delete', succeeded: true, actorId: 'a' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toContain('privileged_operation_client_unavailable')

      // 2 回目は出ない
      spy.mockClear()
      await m.recordPrivilegedOperation({ operation: 'user_delete', succeeded: true, actorId: 'a' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('RPC が例外を投げても特権操作を止めないが、黙りもしない', async () => {
    // WHY(2026-09-08 の変異計測): catch の中身を空にしても緑だった＝**例外経路だけ無音**にできた。
    //      記録の失敗で操作は止めない設計なので、ログが唯一の手がかりになる
    rpc.mockRejectedValue(new Error('network down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = await loadModule()
    await expect(
      m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' }),
    ).resolves.toBeUndefined()
    expect(String(spy.mock.calls[0]?.[0])).toContain('record_privileged_operation')
    spy.mockRestore()
  })

  it('RPC が戻り値の error で失敗したらログに出す（黙って落とさない）', async () => {
    // WHY: PostgREST の失敗は throw ではなく戻り値の error に来る。捨てると try/catch にも
    //      来ないので「記録できていないこと」に誰も気づけない
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const m = await loadModule()
    await m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('record_privileged_operation')
    spy.mockRestore()
  })

  it('成功したときはログに出さない（正常時にログを汚さない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = await loadModule()
    await m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('メールはログに出ない（DB には残すが伏せ字を通る）', async () => {
    // WHY: target_email は PII。DB には残す（誰に招待したかを追うため、2026-09-07 に人が決めた）が、
    //      サーバーログには出さない。log-safe の伏せ字が [email] にする
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'failed for real.person@example.org' },
    })
    const m = await loadModule()
    await m.recordPrivilegedOperation({
      operation: 'user_invite',
      succeeded: true,
      actorId: 'a',
      targetEmail: 'real.person@example.org',
    })
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).not.toContain('real.person@example.org')
    expect(printed).toContain('[email]')
    spy.mockRestore()
  })

  // WHY(#757-31、2026-09-08 の変異計測で未カバーだった): 記録は特権操作の道の途中にあるので、
  //      ここで待つと admin の画面が固まる。上限で諦めても操作は止めないが、
  //      **諦めたことと、どの記録かがログに残る**
  it('RPC が返ってこないときは上限で諦め、操作は止めない（ログには残す）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rpc.mockImplementation(() => new Promise(() => {}))
      const m = await loadModule()
      const promise = m.recordPrivilegedOperation({
        operation: 'user_invite', succeeded: true, actorId: 'a',
      })
      await vi.advanceTimersByTimeAsync(limitsConfig.limits.authJudgmentTimeoutMs)
      await expect(promise).resolves.toBeUndefined()
      const printed = JSON.stringify(spy.mock.calls)
      expect(printed).toContain('judgment-timeout')
      expect(printed).toContain('rpc.record_privileged_operation')
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('クライアントは使い回す（連続する特権操作で作り直さない）', async () => {
    const m = await loadModule()
    await m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: 'a' })
    await m.recordPrivilegedOperation({ operation: 'user_delete', succeeded: true, actorId: 'a' })
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})

// 部分成功の棚卸し（docs/agents/partial-success-inventory.md）: M-021 メール送信だけ失敗したときの記録
describe('失敗の理由の残し方（toOperationErrorCode） [M-021]', () => {
  it('code があればそれを残す', async () => {
    const m = await loadModule()
    expect(m.toOperationErrorCode({ code: 'email_exists', status: 422 })).toBe('email_exists')
  })

  it('code が無ければ HTTP の状態を残す（SMTP 障害の GoTrue は code を付けない）', async () => {
    // WHY: 2026-09-07 にローカルの SMTP を止めて実測した戻り値がこの形
    //      （status 500 / message "Error sending invite email" / code なし）。
    //      code だけを見ていると記録に「失敗」しか残らず、理由が追えない
    const m = await loadModule()
    expect(m.toOperationErrorCode({ status: 500 })).toBe('http_500')
  })

  it('code も status も無ければ unknown（記録を空にしない）', async () => {
    const m = await loadModule()
    expect(m.toOperationErrorCode({})).toBe('unknown')
  })

  it('成功（error が無い）なら null', async () => {
    const m = await loadModule()
    expect(m.toOperationErrorCode(null)).toBeNull()
    expect(m.toOperationErrorCode(undefined)).toBeNull()
  })

  it('100 文字を超える code は切る（DB の CHECK に当たると記録だけが静かに落ちる）', async () => {
    const m = await loadModule()
    const long = 'x'.repeat(300)
    expect(m.toOperationErrorCode({ code: long })).toHaveLength(100)
  })
})
