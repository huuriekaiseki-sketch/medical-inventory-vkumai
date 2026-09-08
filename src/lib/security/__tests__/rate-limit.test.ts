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

  // WHY(2026-09-07 のミューテーション計測): `if (error) return unmeasured` を消しても
  //      全テストが通っていた。エラー時は data が null なので、後ろの `if (!row)` が
  //      同じ結果に落としてしまい、区別がつかなかったため。
  //      ここで固定したいのは「**error があるなら data があっても信じない**」という意図。
  //      これが無いと、将来 RPC が部分的な結果とエラーを同時に返す形になったとき、
  //      壊れた数値を上限判定に使ってしまう（上限を超えているのに通す、が起きうる）。
  it('error と data が同時に返っても数値を信じない（数えられなかった扱い）', async () => {
    rpc.mockResolvedValue({
      data: [{ allowed: false, hit_count: 999, limit_value: 1, reset_at: '2026-09-07T00:00:00Z' }],
      error: { message: 'partial failure' },
    })
    const m = await loadModule()
    const r = await m.consumeUserRequestQuota('user-1')
    expect(r.unmeasured).toBe(true)
    expect(r.allowed).toBe(true)
    expect(r.hitCount).toBeNull()
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

  // WHY(#757-31): これは requireAuth の中にあり **全 route が通る**。PostgREST を止めた実測で
  //      18 秒かかっていた。上限は認可ではないので、諦めたら通す（fail-open）。
  //      ただし**諦めたこと自体は記録に残す**
  it('RPC が返ってこないときは上限で諦めて通す（上限を可用性の穴にしない）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      rpc.mockImplementation(() => new Promise(() => {}))
      const m = await loadModule()
      const promise = m.consumeUserRequestQuota('user-1')
      await vi.advanceTimersByTimeAsync(limitsConfig.limits.authJudgmentTimeoutMs)
      const r = await promise
      expect(r.allowed).toBe(true)
      expect(r.unmeasured).toBe(true)
      expect(JSON.stringify(spy.mock.calls)).toContain('judgment-timeout')
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})

// 部分成功の棚卸し（docs/agents/partial-success-inventory.md）: M-021 送れなかった分の枠を戻す
describe('招待の枠の払い戻し（refundInviteQuota） [M-021][Q-020]', () => {
  beforeEach(() => {
    rpc.mockReset()
    recordAccessDenial.mockReset()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  it('消費と同じバケット・同じ窓を指して戻す（違う行を減らさない）', async () => {
    // WHY: 払い戻しが別のバケットを減らすと、**他人の枠を静かに増やす**ことになる。
    //      窓の秒数も消費と同じでなければ DB 側で別の行の鍵になる
    rpc.mockResolvedValue({ data: [{ refunded: true, hit_count: 0 }], error: null })
    const m = await loadModule()
    await m.consumeInviteQuota('admin-1')
    const consumeArgs = rpc.mock.calls[0][1]

    rpc.mockClear()
    await m.refundInviteQuota('admin-1')
    const refundArgs = rpc.mock.calls[0][1]

    expect(rpc.mock.calls[0][0]).toBe('refund_rate_limit')
    expect(refundArgs.p_bucket).toBe(consumeArgs.p_bucket)
    expect(refundArgs.p_window_seconds).toBe(consumeArgs.p_window_seconds)
  })

  it('減らせたら true', async () => {
    rpc.mockResolvedValue({ data: [{ refunded: true, hit_count: 3 }], error: null })
    const m = await loadModule()
    await expect(m.refundInviteQuota('admin-1')).resolves.toBe(true)
  })

  it('窓が変わって行が無ければ false（新しい窓の行を減らさない）', async () => {
    rpc.mockResolvedValue({ data: [{ refunded: false, hit_count: null }], error: null })
    const m = await loadModule()
    await expect(m.refundInviteQuota('admin-1')).resolves.toBe(false)
  })

  it('RPC が戻り値の error で失敗したら false を返し、ログに出す（黙って落とさない）', async () => {
    // WHY: PostgREST の失敗は throw ではなく戻り値の error に来る。捨てると
    //      「払い戻せていないこと」に誰も気づけない（2026-09-07 に access-denial.ts で起きた形）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } })
    const m = await loadModule()
    await expect(m.refundInviteQuota('admin-1')).resolves.toBe(false)
    expect(String(spy.mock.calls[0]?.[0])).toContain('refund_rate_limit')
    spy.mockRestore()
  })

  it('例外を投げても呼び出し側を止めない（枠が 1 つ減ったままになるだけ）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rpc.mockRejectedValue(new Error('network down'))
    const m = await loadModule()
    await expect(m.refundInviteQuota('admin-1')).resolves.toBe(false)
    spy.mockRestore()
  })

  it('service role の環境変数が無い実行環境では呼ばない', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const m = await loadModule()
    await expect(m.refundInviteQuota('admin-1')).resolves.toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })
})
