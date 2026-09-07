// WHY: issue #757 の 7（ミューテーションテスト）で見つけた穴。このファイルには
//      単体テストが 1 本も無く、変異の 37 個すべてが生き残っていた（スコア 0.00%）。
//      統合テストはあるが `npm test` から除外されているので、毎 PR では守られていなかった。
//
//      ここで固定するのは「拒否そのものを止めない」こと。記録は証跡であって拒否ではないので、
//      環境変数が無くても・ヘッダが読めなくても・RPC が落ちても、例外を投げてはいけない
//      （docs/agents/fail-open-inventory.md の型）。

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('URL が無い場合も同じ（両方揃って初めて記録する）', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('RPC が落ちても例外を投げない（拒否そのものを止めない）', async () => {
    rpc.mockRejectedValue(new Error('network down'))
    const m = await loadModule()
    await expect(m.recordAccessDenial({ guard: 'facility', reason: 'forbidden' })).resolves.toBeUndefined()
  })

  it('クライアントは使い回す（連続する拒否で作り直さない）', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('セッションを持たないクライアントとして作る', async () => {
    const m = await loadModule()
    await m.recordAccessDenial({ guard: 'auth', reason: 'unauthenticated' })
    expect(createClient).toHaveBeenCalledWith('http://localhost:54321', 'test-service-role-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })
})
