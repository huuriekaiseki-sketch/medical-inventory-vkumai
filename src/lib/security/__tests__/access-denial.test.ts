// WHY: issue #757 の 7（ミューテーションテスト）で見つけた穴。このファイルには
//      単体テストが 1 本も無く、変異の 37 個すべてが生き残っていた（スコア 0.00%）。
//      統合テストはあるが `npm test` から除外されているので、毎 PR では守られていなかった。
//
//      ここで固定するのは「拒否そのものを止めない」こと。記録は証跡であって拒否ではないので、
//      環境変数が無くても・ヘッダが読めなくても・RPC が落ちても、例外を投げてはいけない
//      （docs/agents/fail-open-inventory.md の型）。

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
  return import('../access-denial')
}

describe('拒否された操作の記録（recordAccessDenial） [P-063]', () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null })
    createClient.mockClear()
    headersGet.mockReset().mockReturnValue(null)
    headers.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  it('渡された内容を RPC にそのまま記録する', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({
      guard: 'facility',
      reason: 'forbidden',
      actorId: 'u1',
      facilityId: 'f1',
      route: '/api/orders',
      method: 'GET',
    })
    expect(rpc).toHaveBeenCalledWith('record_access_denial', {
      p_guard: 'facility',
      p_reason: 'forbidden',
      p_route: '/api/orders',
      p_method: 'GET',
      p_actor_id: 'u1',
      p_facility_id: 'f1',
    })
  })

  it('経路を渡さないときは proxy が付けたヘッダから取る', async () => {
    headersGet.mockImplementation((name: string) =>
      name === 'x-aidd-route' ? '/api/facilities' : name === 'x-aidd-method' ? 'POST' : null
    )
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(headers).toHaveBeenCalled()
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_route: '/api/facilities', p_method: 'POST' })
  })

  it('経路を明示したときはヘッダを読みに行かない', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated', route: null, method: null })
    expect(headers).not.toHaveBeenCalled()
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_route: undefined, p_method: undefined })
  })

  // WHY(2026-09-07 のミューテーション計測): 経路の判定は
  //      `denial.route !== undefined || denial.method !== undefined` で、
  //      **どちらか一方でも渡されていれば「呼び出し側が明示した」**とみなす。
  //      これを `&&` に書き換えても全テストが通っていた（片方だけ渡すケースが無かった）。
  //      `&&` になると、片方だけ明示した呼び出しでヘッダを読みに行き、
  //      明示した値が上書きされる（記録の経路が実際と違うものになる）。
  it.each([
    { label: 'route だけ明示', denial: { route: '/api/x' }, expected: { p_route: '/api/x', p_method: undefined } },
    { label: 'method だけ明示', denial: { method: 'DELETE' }, expected: { p_route: undefined, p_method: 'DELETE' } },
  ])('$label でもヘッダを読みに行かない', async ({ denial, expected }) => {
    headersGet.mockImplementation((name: string) =>
      name === 'x-aidd-route' ? '/from-header' : name === 'x-aidd-method' ? 'GET' : null
    )
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated', ...denial })
    expect(headers).not.toHaveBeenCalled()
    expect(rpc.mock.calls[0][1]).toMatchObject(expected)
  })

  it('ヘッダが読めない実行環境（Route Handler の外）でも記録は続く', async () => {
    headers.mockRejectedValueOnce(new Error('headers() outside request scope'))
    const m = await loadModule()
    await expect(m.recordAccessDenial({ guard: 'admin', reason: 'not_admin' })).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_route: undefined, p_method: undefined })
  })

  it('service role の環境変数が無ければ記録しない（例外も投げない）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const m = await loadModule()
    await expect(m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })).resolves.toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('env 未設定時は初回だけ警告ログが出る（SPEC part 1、受け入れ条件1）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const m = await loadModule()
      // 1回目：警告ログが出る
      await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toContain('access_denial_client_unavailable')

      // 2回目：警告ログが出ない（同一プロセス内で重複しない）
      spy.mockClear()
      await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('URL が無い場合も同じ（両方揃って初めて記録する）', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).not.toHaveBeenCalled()
  })

  // WHY(2026-09-18): 外側 catch のログ（`record_access_denial_unexpected`）を足したが、守るテストが
  //      無く、その行を消しても全テストが緑のままだった（1 行ずつ壊して実測）。
  //      「投げない」と「黙らない」を同じテストで対にして固定する。
  //      context は戻り値の error の `record_access_denial` と**別**であることまで見る
  //      （片方がもう片方を部分文字列として含むので、toContain だけでは取り違えを見逃す）
  it('RPC が例外で落ちても投げないが、想定外の例外としてログには残す（黙って落とさない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rpc.mockRejectedValue(new Error('network down'))
      const m = await loadModule()
      await expect(m.recordAccessDenial({ guard: 'facility', reason: 'forbidden' })).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toContain('record_access_denial_unexpected')
    } finally {
      spy.mockRestore()
    }
  })

  // WHY: PostgREST の失敗は throw ではなく**戻り値の error** に来る。捨てると try/catch にも
  //      来ないので「記録できていないこと」に誰も気づけない（2026-09-07 に実際に起きた）。
  //      握りつぶすのは「拒否そのものを止めない」ためであって、黙ることではない。
  //      2026-09-07 のミューテーション計測では `if (error)` を `if (true)` にしても
  //      `if (false)` にしても全テストが通っていた＝この分岐は誰も見ていなかった。
  it('RPC が戻り値の error で失敗したらログに出す（黙って落とさない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const m = await loadModule()
    await expect(m.recordAccessDenial({ guard: 'facility', reason: 'forbidden' })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('record_access_denial')
    // 想定外の例外の context とは別物（こちらは PostgREST が返した error）
    expect(String(spy.mock.calls[0][0])).not.toContain('record_access_denial_unexpected')
    spy.mockRestore()
  })

  it('成功したときはログに出さない（正常時にログを汚さない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'facility', reason: 'forbidden' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('クライアントは使い回す（連続する拒否で作り直さない）', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  // WHY(#757-31、2026-09-08 の変異計測で未カバーだった): 記録は拒否の道の途中にある。
  //      PostgREST が落ちているときにここで待つと、拒否を返すまでに約 16 秒かかっていた。
  //      上限で諦めても拒否は変わらないが、**諦めたことと、どの記録かがログに残る**
  it('RPC が返ってこないときは上限で諦め、拒否は止めない（ログには残す）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rpc.mockImplementation(() => new Promise(() => {}))
      const m = await loadModule()
      const promise = m.recordAccessDenial({ guard: 'facility', reason: 'forbidden' })
      await vi.advanceTimersByTimeAsync(limitsConfig.limits.authJudgmentTimeoutMs)
      await expect(promise).resolves.toBeUndefined()
      const printed = JSON.stringify(spy.mock.calls)
      expect(printed).toContain('judgment-timeout')
      expect(printed).toContain('rpc.record_access_denial')
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('セッションを持たないクライアントとして作る', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).toHaveBeenCalledWith('http://localhost:54321', 'test-service-role-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })
})
