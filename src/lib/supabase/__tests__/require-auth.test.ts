import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'

// WHY(#757-7): ミューテーションテストで、拒否の記録（guard / reason の中身）と
//      回数の上限の分岐が 1 つも検査されていないことが分かった（変異が生き残った）。
//      呼ばれたこと・何を渡したか・上限を超えたら止まることを固定する。
const recordAccessDenial = vi.fn()
const consumeUserRequestQuota = vi.fn()

vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: (...args: unknown[]) => recordAccessDenial(...args),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  consumeUserRequestQuota: (...args: unknown[]) => consumeUserRequestQuota(...args),
}))

import { requireAuth } from '@/lib/supabase/require-auth'
import { AUTH_JUDGMENT_TIMEOUT_MS } from '@/lib/security/judgment-timeout'

function makeDb(user: User | null, error: Error | null = null): SupabaseClient {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error }),
    },
  } as unknown as SupabaseClient
}

const allowed = { allowed: true, hitCount: 1, limit: 300, resetAt: null, unmeasured: false }
const denied = { allowed: false, hitCount: 301, limit: 300, resetAt: null, unmeasured: false }

const USER = { id: 'u-1', email: 'test@example.com' } as User

beforeEach(() => {
  recordAccessDenial.mockReset()
  consumeUserRequestQuota.mockReset().mockResolvedValue(allowed)
})

// P-001（docs/agents/promise-catalog.md）: 未認証の呼び出しは requireAuth が UNAUTHORIZED で止める
describe('requireAuth (P-001)', () => {
  it('認証済みユーザーを返す', async () => {
    const result = await requireAuth(makeDb(USER))
    expect(result).toBe(USER)
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('user が null の場合 UNAUTHORIZED をスロー', async () => {
    await expect(requireAuth(makeDb(null))).rejects.toThrow('UNAUTHORIZED')
  })

  it('error がある場合 UNAUTHORIZED をスロー', async () => {
    await expect(requireAuth(makeDb(USER, new Error('session error')))).rejects.toThrow('UNAUTHORIZED')
  })

  it('未認証の拒否は guard=auth / reason=unauthenticated で記録される', async () => {
    await expect(requireAuth(makeDb(null))).rejects.toThrow('UNAUTHORIZED')
    expect(recordAccessDenial).toHaveBeenCalledWith({ guard: 'auth', reason: 'unauthenticated' })
  })

  it('未認証のときは回数を数えない（数えるのは認証を通った人だけ）', async () => {
    await expect(requireAuth(makeDb(null))).rejects.toThrow('UNAUTHORIZED')
    expect(consumeUserRequestQuota).not.toHaveBeenCalled()
  })
})

// P-064: 回数の上限を超えた分は止まる
describe('requireAuth の回数の上限 (P-064)', () => {
  it('認証を通った人の ID で数える', async () => {
    await requireAuth(makeDb(USER))
    expect(consumeUserRequestQuota).toHaveBeenCalledWith('u-1')
  })

  it('上限を超えたら RATE_LIMITED で止める', async () => {
    consumeUserRequestQuota.mockResolvedValue(denied)
    await expect(requireAuth(makeDb(USER))).rejects.toThrow('RATE_LIMITED')
  })

  it('数えられなかったとき（fail-open）は通す', async () => {
    consumeUserRequestQuota.mockResolvedValue({ ...allowed, unmeasured: true })
    await expect(requireAuth(makeDb(USER))).resolves.toBe(USER)
  })
})

// WHY(#757-31): GoTrue を止めた実測で `getUser` が **54 秒**返らなかった。
//      `requireAuth` は全 route が通るので、ここが詰まると製品全体が止まる。
//      上限で諦めたときは「誰か分からない」＝未認証に倒す（通してはいけない）
describe('requireAuth の待ち時間の上限 (F-001)', () => {
  it('getUser が返ってこないときは上限で諦めて UNAUTHORIZED', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = {
        auth: { getUser: vi.fn(() => new Promise(() => {})) },
      } as unknown as SupabaseClient
      const assertion = expect(requireAuth(db)).rejects.toThrow('UNAUTHORIZED')
      await vi.advanceTimersByTimeAsync(AUTH_JUDGMENT_TIMEOUT_MS)
      await assertion
      expect(recordAccessDenial).toHaveBeenCalledWith({ guard: 'auth', reason: 'unauthenticated' })
      // 諦めたことは記録に残る（拒否が増えただけに見えないように）
      expect(JSON.stringify(spy.mock.calls)).toContain('judgment-timeout')
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})
