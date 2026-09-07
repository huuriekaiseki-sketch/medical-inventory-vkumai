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

// 部分成功の棚卸し（docs/agents/partial-success-inventory.md）: M-021 送れなかった分の枠を戻す
describe('枠の払い戻し（refund_rate_limit） [M-021][Q-020]', () => {
  const service = createServiceRoleClient()

  it('消費した分を戻すと、その窓であと 1 回多く通る', async () => {
    // WHY: route の使い方（消費 → 送信が失敗 → 戻す → もう一度押す）をそのままなぞる。
    //      戻さなければ 3 回目は上限超えで止まる
    const bucket = `test:${randomUUID()}`
    const consume = () => service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 2, p_window_seconds: 60 })

    const { data: first } = await consume()
    const { data: second } = await consume()
    expect([first![0].allowed, second![0].allowed]).toEqual([true, true])
    expect(second![0].hit_count).toBe(2)

    const { data: refund, error } = await service.rpc('refund_rate_limit', {
      p_bucket: bucket,
      p_window_seconds: 60,
    })
    expect(error).toBeNull()
    expect(refund![0]).toEqual({ refunded: true, hit_count: 1 })

    const { data: third } = await consume()
    expect(third![0].allowed).toBe(true)
    expect(third![0].hit_count).toBe(2)
  })

  it('上限で止まった分は戻らない（止まった試行もカウンタを進める。固定窓の性質）', async () => {
    // WHY: 上限に当たった呼び出しも hits を +1 する。route はその場合 GoTrue を呼ばないので
    //      払い戻しもしない。**上限に当たり始めると窓が変わるまで戻らない**ことをここで固定する
    //      （払い戻しがこの性質を打ち消すと誤解されないように）
    const bucket = `test:${randomUUID()}`
    const consume = () => service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 1, p_window_seconds: 60 })
    await consume()
    const { data: blocked } = await consume()
    expect(blocked![0]).toMatchObject({ allowed: false, hit_count: 2 })
  })

  it('消費していないバケットは戻せない（refunded=false。他人の行を減らさない）', async () => {
    const { data, error } = await service.rpc('refund_rate_limit', {
      p_bucket: `never-used:${randomUUID()}`,
      p_window_seconds: 60,
    })
    expect(error).toBeNull()
    expect(data![0]).toEqual({ refunded: false, hit_count: null })
  })

  it('消費より多く戻しても 0 未満にならない（上限を無効化できない）', async () => {
    // WHY: 負のカウンタを作れると、以後その窓では上限が実質的に効かなくなる
    const bucket = `test:${randomUUID()}`
    await service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 1, p_window_seconds: 60 })
    for (let i = 0; i < 5; i++) {
      await service.rpc('refund_rate_limit', { p_bucket: bucket, p_window_seconds: 60 })
    }
    const { data, error } = await service.rpc('refund_rate_limit', { p_bucket: bucket, p_window_seconds: 60 })
    // GREATEST を外すと CHECK (hits >= 0) に当たって error になる（2026-09-08 に変異で実測）
    expect(error, `0 未満になろうとした: ${error?.message}`).toBeNull()
    expect(data![0].hit_count).toBe(0)
  })

  it('窓の秒数が違えば別の行を見る（消費した窓だけを戻す）', async () => {
    // WHY: アプリ側が消費と払い戻しで違う窓を渡すと、**減らすつもりのない行**を減らす。
    //      DB 側でも「別の窓は別の行」であることを固定する
    const bucket = `test:${randomUUID()}`
    await service.rpc('consume_rate_limit', { p_bucket: bucket, p_limit: 5, p_window_seconds: 60 })
    const { data: otherWindow } = await service.rpc('refund_rate_limit', {
      p_bucket: bucket,
      p_window_seconds: 3600,
    })
    expect(otherWindow![0].refunded).toBe(false)
  })

  it('client ロールは払い戻しを呼べない（自分の枠を戻し放題にできない）', async () => {
    const { error } = await createAnonClient().rpc('refund_rate_limit', {
      p_bucket: `forged:${randomUUID()}`,
      p_window_seconds: 60,
    })
    expect(error?.code).toBe(UNAUTHORIZED)
  })

  it('窓の秒数は 1 未満にできない', async () => {
    const { error } = await service.rpc('refund_rate_limit', {
      p_bucket: `test:${randomUUID()}`,
      p_window_seconds: 0,
    })
    expect(error).not.toBeNull()
  })
})
