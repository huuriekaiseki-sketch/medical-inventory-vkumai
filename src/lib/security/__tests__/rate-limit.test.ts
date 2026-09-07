// WHY: issue #757 の 32（Q-002）。上限そのものは DB の consume_rate_limit が守るので、
//      ここで確かめるのはアプリ側の 3 つ:
//        - 値を自分で持たず aidd.config.json（人が決めた値）から読む
//        - 数えられないときは通す（fail-open。上限は認可ではない）
//        - 上限を超えたら拒否として記録する（人の回答「拒否して記録に残す」）

import { beforeEach, describe, expect, it, vi } from 'vitest'
import limitsConfig from '../../../../aidd.config.json'

const rpc = vi.fn()
const recordAccessDenial = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc }),
}))
vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: (...args: unknown[]) => recordAccessDenial(...args),
}))

async function loadModule() {
  vi.resetModules()
  return import('../rate-limit')
}

describe('回数の上限（rate limit） [P-064][Q-002]', () => {
  beforeEach(() => {
    rpc.mockReset()
    recordAccessDenial.mockReset()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  it('上限は aidd.config.json の値をそのまま使う（コードに数字を埋めない）', async () => {
    const m = await loadModule()
    expect(m.REQUESTS_PER_MINUTE).toBe(limitsConfig.limits.requestsPerMinute)
    expect(m.INVITES_PER_DAY).toBe(limitsConfig.limits.invitesPerDay)
  })

  it('上限内なら allowed=true で、拒否は記録しない', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: true, hit_count: 5, limit_value: 300, reset_at: '2026-09-07T00:01:00Z' }],
      error: null,
    })
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.allowed).toBe(true)
    expect(r.unmeasured).toBe(false)
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('上限を超えたら allowed=false になり、拒否として記録される', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: false, hit_count: 301, limit_value: 300, reset_at: '2026-09-07T00:01:00Z' }],
      error: null,
    })
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.allowed).toBe(false)
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'rate_limit',
      reason: 'rate_limited',
      actorId: 'user-1',
    })
  })

  it('招待メールは 1 日の上限と別の bucket で数える', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: true, hit_count: 1, limit_value: 50, reset_at: '2026-09-08T00:00:00Z' }],
      error: null,
    })
    const m = await loadModule()
    await m.consumeInviteQuota('admin-1')
    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_bucket: 'invite:admin-1',
      p_limit: limitsConfig.limits.invitesPerDay,
      p_window_seconds: 86400,
    })
  })

  // WHY(#757-7): ミューテーションテストで、利用者の bucket 名と招待の拒否記録が
  //      1 つも検査されていないことが分かった（変異が生き残った）
  it('利用者の上限は user:<id> の bucket で数える', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: true, hit_count: 1, limit_value: 300, reset_at: '2026-09-07T00:01:00Z' }],
      error: null,
    })
    const m = await loadModule()
    await m.consumeUserRequestQuota('user-42')
    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_bucket: 'user:user-42',
      p_limit: limitsConfig.limits.requestsPerMinute,
      p_window_seconds: 60,
    })
  })

  it('招待の上限を超えたら拒否として記録される', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: false, hit_count: 51, limit_value: 50, reset_at: '2026-09-08T00:00:00Z' }],
      error: null,
    })
    const m = await loadModule()
    const r = await m.consumeInviteQuota('admin-1')
    expect(r.allowed).toBe(false)
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'rate_limit',
      reason: 'rate_limited',
      actorId: 'admin-1',
    })
  })

  it('招待が上限内なら記録しない', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: true, hit_count: 1, limit_value: 50, reset_at: '2026-09-08T00:00:00Z' }],
      error: null,
    })
    const m = await loadModule()
    await m.consumeInviteQuota('admin-1')
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('行が返ってこないときは数えられなかった扱いにする', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.unmeasured).toBe(true)
    expect(r.allowed).toBe(true)
  })

  it('DB がエラーを返したら通す（fail-open）が、数えられなかったことを返す', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.allowed).toBe(true)
    expect(r.unmeasured).toBe(true)
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('RPC が例外を投げても通す（拒否の仕組みが可用性の穴にならない）', async () => {
    rpc.mockRejectedValue(new Error('network down'))
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.allowed).toBe(true)
    expect(r.unmeasured).toBe(true)
  })

  it('service role の環境変数が無い実行環境では数えない', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.unmeasured).toBe(true)
    expect(rpc).not.toHaveBeenCalled()
  })
})
