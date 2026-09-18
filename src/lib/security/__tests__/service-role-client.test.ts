// WHY: issue #793。service_role クライアントの生成・キャッシュ・env 未設定時の初回警告は、
//      4 ファイル（access-denial / hidden-row-denial / privileged-operation / rate-limit）に
//      同じものがコピペされていた。**しかも警告を持っていたのは 1 ファイルだけ**で、
//      残り 3 つは env が無いと黙って null を返し、記録がまるごと落ちていた。
//      一本化した以上、ここが壊れると 4 経路が同時に壊れるので、この 1 本で固定する。
//
//      特に「呼び出し元ごとに独立したキャッシュ」は、プロセス全体の Singleton にすると
//      **先に呼ばれた側の logKey でしか警告が出なくなる**（どの記録経路が死んだか分からない）。
//      その独立性をテストで固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const createClient = vi.fn(() => ({ rpc: vi.fn() }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}))

async function loadModule() {
  vi.resetModules()
  return import('../service-role-client')
}

describe('service_role クライアントの取得口（createServiceRoleClientAccessor）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  it('env が揃っていればクライアントを返す', async () => {
    const { createServiceRoleClientAccessor } = await loadModule()
    const accessor = createServiceRoleClientAccessor('probe')
    expect(accessor.get()).not.toBeNull()
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('セッションを持たないクライアントとして作る（拒否の記録で使い回すため）', async () => {
    const { createServiceRoleClientAccessor } = await loadModule()
    createServiceRoleClientAccessor('probe').get()
    expect(createClient).toHaveBeenCalledWith('http://localhost:54321', 'test-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })

  it('2 回目以降は作り直さない（使い回す）', async () => {
    const { createServiceRoleClientAccessor } = await loadModule()
    const accessor = createServiceRoleClientAccessor('probe')
    accessor.get()
    accessor.get()
    accessor.get()
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('env が無ければ null を返し、例外は投げない（記録は fail-open）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { createServiceRoleClientAccessor } = await loadModule()
    const accessor = createServiceRoleClientAccessor('probe')
    expect(accessor.get()).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('URL だけ無い場合も null（両方揃って初めて作る）', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const { createServiceRoleClientAccessor } = await loadModule()
    expect(createServiceRoleClientAccessor('probe').get()).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('env 未設定のときは初回だけ警告ログを出す（黙って落とさない）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { createServiceRoleClientAccessor } = await loadModule()
      const accessor = createServiceRoleClientAccessor('my_log_key')

      accessor.get()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toContain('my_log_key')

      // 2 回目以降は出ない（拒否のたびにログが溢れない）
      spy.mockClear()
      accessor.get()
      accessor.get()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  // ここが「呼び出し元ごとに独立」の肝。グローバル Singleton にすると落ちる
  it('取得口ごとにキャッシュが独立する（別の logKey なら別々に警告が出る）', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { createServiceRoleClientAccessor } = await loadModule()
      const a = createServiceRoleClientAccessor('key_a')
      const b = createServiceRoleClientAccessor('key_b')

      a.get()
      b.get()

      expect(spy).toHaveBeenCalledTimes(2)
      const logged = spy.mock.calls.map(c => String(c[0]))
      expect(logged.some(l => l.includes('key_a'))).toBe(true)
      expect(logged.some(l => l.includes('key_b'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('resetForTests の後は作り直す（env を差し替えたテストのため）', async () => {
    const { createServiceRoleClientAccessor } = await loadModule()
    const accessor = createServiceRoleClientAccessor('probe')
    accessor.get()
    expect(createClient).toHaveBeenCalledTimes(1)

    accessor.resetForTests()
    accessor.get()
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('resetForTests は他の取得口に影響しない', async () => {
    const { createServiceRoleClientAccessor } = await loadModule()
    const a = createServiceRoleClientAccessor('key_a')
    const b = createServiceRoleClientAccessor('key_b')
    a.get()
    b.get()
    expect(createClient).toHaveBeenCalledTimes(2)

    a.resetForTests()
    a.get()
    b.get() // b は作り直されない
    expect(createClient).toHaveBeenCalledTimes(3)
  })
})
