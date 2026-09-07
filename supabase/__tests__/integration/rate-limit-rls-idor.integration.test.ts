// supabase/__tests__/integration/rate-limit-rls-idor.integration.test.ts
// WHY: issue #757 の 32（回数の上限、quota-inventory の Q-002 / Q-020）。
//      実 DB で確かめるのは 5 つ:
//        - 上限までは通り、超えた分だけ止まる（固定窓の数え方が正しい）
//        - 人が違えば別に数える（1 人の使い方で他人が止まらない）
//        - 窓が違えば別に数える（時間が経てば戻る）
//        - client ロールは数を読めない・書けない・関数も呼べない（自分の上限を消せない）
//        - 不正な引数は例外（上限 0 で「常に拒否」を作れない）

import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createServiceRoleClient } from './helpers/seed-rls-idor'

const UNAUTHORIZED = '42501'

function createAnonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

describe('回数の上限（rate_limit_counters / consume_rate_limit） [P-064][Q-002]', () => {
  const service = createServiceRoleClient()

  it('上限までは通り、超えた分だけ止まる', async () => {
    const bucket = `test:${randomUUID()}`
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const { data, error } = await service.rpc('consume_rate_limit', {
        p_bucket: bucket,
        p_limit: 3,
        p_window_seconds: 60,
      })
      expect(error).toBeNull()
      results.push(data![0].allowed)
    }
    expect(results).toEqual([true, true, true, false, false])
  })

  it('人（bucket）が違えば別に数える', async () => {
    const a = `test:${randomUUID()}`
    const b = `test:${randomUUID()}`
    for (let i = 0; i < 3; i++) {
      await service.rpc('consume_rate_limit', { p_bucket: a, p_limit: 3, p_window_seconds: 60 })
    }
    const { data: aOver } = await service.rpc('consume_rate_limit', { p_bucket: a, p_limit: 3, p_window_seconds: 60 })
    const { data: bFirst } = await service.rpc('consume_rate_limit', { p_bucket: b, p_limit: 3, p_window_seconds: 60 })
    expect(aOver![0].allowed).toBe(false)
    expect(bFirst![0].allowed).toBe(true)
  })

  it('窓が違えば別に数える（1 秒窓で使い切ってから待つと戻る）', async () => {
    const bucket = `test:${randomUUID()}`
    await service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 1, p_window_seconds: 1 })
    const { data: blocked } = await service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 1, p_window_seconds: 1 })
    expect(blocked![0].allowed).toBe(false)
    await new Promise((r) => setTimeout(r, 1200))
    const { data: recovered } = await service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 1, p_window_seconds: 1 })
    expect(recovered![0].allowed).toBe(true)
  })

  it('上限は 1 未満にできない（常に拒否する設定を作れない）', async () => {
    const { error: zeroLimit } = await service.rpc('consume_rate_limit', {
      p_bucket: `test:${randomUUID()}`,
      p_limit: 0,
      p_window_seconds: 60,
    })
    expect(zeroLimit).not.toBeNull()
    const { error: zeroWindow } = await service.rpc('consume_rate_limit', {
      p_bucket: `test:${randomUUID()}`,
      p_limit: 3,
      p_window_seconds: 0,
    })
    expect(zeroWindow).not.toBeNull()
  })

  it('client ロールはカウンタを読めない・書けない・関数も呼べない', async () => {
    const anon = createAnonClient()
    const { error: readError } = await anon.from('rate_limit_counters').select('*').limit(1)
    expect(readError).not.toBeNull()

    const { error: writeError } = await anon
      .from('rate_limit_counters')
      .insert({ bucket: `forged:${randomUUID()}`, window_start: new Date().toISOString(), hits: 0 })
    expect(writeError).not.toBeNull()

    const { error: rpcError } = await anon.rpc('consume_rate_limit', {
      p_bucket: `forged:${randomUUID()}`,
      p_limit: 3,
      p_window_seconds: 60,
    })
    expect(rpcError).not.toBeNull()
    expect(rpcError?.code).toBe(UNAUTHORIZED)
  })
})
