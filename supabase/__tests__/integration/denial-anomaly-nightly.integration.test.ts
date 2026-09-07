// supabase/__tests__/integration/denial-anomaly-nightly.integration.test.ts
// WHY: issue #757 の 8（安全性のモニタリング）。実 DB で確かめるのは 6 つ:
//        - 閾値を超えた人だけが挙がる（超えていない人は挙がらない）
//        - 窓をまたいで散らばった拒否は挙がらない（滑走窓が効いている）
//        - 未認証（actor_id が null）の拒否は guard ごとにまとめて数える
//        - 記録は冪等（2 回呼んでも 1 行）
//        - 収まったら自動で resolved になる（issue が自動で閉じる）
//        - client ロールは検知も記録も呼べない
//        - object_name に利用者の ID がそのまま出ない（anon キーで読める view を通るため）

import { createHash, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceRoleClient } from './helpers/seed-rls-idor'

const UNAUTHORIZED = '42501'

function createAnonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-065 拒否の並びが異常なら毎晩検知して記録される
describe('拒否の異常検知（check_denial_anomalies / record_denial_anomalies） [P-065]', () => {
  const service = createServiceRoleClient()

  // WHY: access_denials は append-only（service_role でも DELETE できない）ので、
  //      テストごとに新しい actor_id を使って他のテストと混ざらないようにする
  const actor = randomUUID()
  const quiet = randomUUID()
  // WHY: object_name は actor_id の伏せ字（md5 の先頭 12 桁）。実 ID は detail にだけ入る
  const digest = (id: string) => 'user:' + createHash('md5').update(id).digest('hex').slice(0, 12)
  const actorSubject = digest(actor)
  const quietSubject = digest(quiet)

  async function denyOnce(actorId: string | null, guard = 'facility', reason = 'forbidden') {
    const { error } = await service.rpc('record_access_denial', {
      p_guard: guard,
      p_reason: reason,
      p_actor_id: actorId ?? undefined,
    })
    expect(error).toBeNull()
  }

  async function anomaliesFor(subject: string, threshold = 5) {
    const { data, error } = await service.rpc('check_denial_anomalies', {
      p_threshold: threshold,
      p_window_seconds: 3600,
      p_lookback_seconds: 86400,
    })
    expect(error).toBeNull()
    return (data ?? []).filter((r: { subject: string }) => r.subject === subject)
  }

  beforeEach(async () => {
    // 5 回で異常とみなす設定にして、6 回弾かれた人と 2 回だけの人を作る
    for (let i = 0; i < 6; i++) await denyOnce(actor)
    for (let i = 0; i < 2; i++) await denyOnce(quiet)
  })

  afterEach(async () => {
    await service.from('schema_drift_log').delete().eq('drift_type', 'denial_anomaly')
  })

  it('閾値を超えた人だけが挙がり、超えていない人は挙がらない', async () => {
    const hit = await anomaliesFor(actorSubject, 5)
    expect(hit).toHaveLength(1)
    expect(Number(hit[0].hits)).toBeGreaterThanOrEqual(6)
    expect(hit[0].detail.threshold).toBe(5)
    expect(hit[0].detail.guards).toEqual({ facility: 6 })
    expect(hit[0].detail.reasons).toEqual({ forbidden: 6 })

    const miss = await anomaliesFor(quietSubject, 5)
    expect(miss).toHaveLength(0)
  })

  it('閾値を上げれば挙がらなくなる（数え方が閾値に従っている）', async () => {
    expect(await anomaliesFor(actorSubject, 100)).toHaveLength(0)
  })

  it('未認証の拒否は guard ごとにまとめて数える', async () => {
    const before = await anomaliesFor('anonymous:auth', 5)
    for (let i = 0; i < 6; i++) await denyOnce(null, 'auth', 'unauthenticated')
    const after = await anomaliesFor('anonymous:auth', 5)
    expect(after).toHaveLength(1)
    expect(Number(after[0].hits)).toBeGreaterThan(Number(before[0]?.hits ?? 0))
  })

  it('記録は冪等（2 回呼んでも未解決の行は 1 つ）', async () => {
    await service.rpc('record_denial_anomalies', { p_threshold: 5, p_window_seconds: 3600, p_lookback_seconds: 86400 })
    await service.rpc('record_denial_anomalies', { p_threshold: 5, p_window_seconds: 3600, p_lookback_seconds: 86400 })

    const { data } = await service
      .from('schema_drift_log')
      .select('*')
      .eq('drift_type', 'denial_anomaly')
      .eq('object_name', actorSubject)
      .is('resolved_at', null)
    expect(data).toHaveLength(1)
    expect(data![0].event_kind).toBe('detected')
  })

  it('収まったら自動で resolved になる（issue が自動で閉じる）', async () => {
    await service.rpc('record_denial_anomalies', { p_threshold: 5, p_window_seconds: 3600, p_lookback_seconds: 86400 })

    // 閾値を上げて「もう異常ではない」状態にして、もう一度記録する
    await service.rpc('record_denial_anomalies', { p_threshold: 1000, p_window_seconds: 3600, p_lookback_seconds: 86400 })

    const { data } = await service
      .from('schema_drift_log')
      .select('*')
      .eq('drift_type', 'denial_anomaly')
      .eq('object_name', actorSubject)
    expect(data).toHaveLength(1)
    expect(data![0].event_kind).toBe('resolved')
    expect(data![0].resolved_at).not.toBeNull()
  })

  it('object_name に利用者の ID がそのまま出ない（anon キーで読める view を通るため）', async () => {
    await service.rpc('record_denial_anomalies', { p_threshold: 5, p_window_seconds: 3600, p_lookback_seconds: 86400 })

    // WHY(未解決だけを見る): 直前のテストが 1 度 resolved にしており、その行は履歴として残る。
    //      解決済みの行は部分 UNIQUE（WHERE resolved_at IS NULL）の対象外なので、
    //      再検知は**新しい行**として増える。全件を数えると 2 行になり、
    //      「1 行だけのはず」という前提が崩れる（2026-09-07 のマージ時に実測して発見）。
    const { data } = await service
      .from('schema_drift_log')
      .select('object_name, detail')
      .eq('drift_type', 'denial_anomaly')
      .eq('object_name', actorSubject)
      .is('resolved_at', null)
    expect(data).toHaveLength(1)
    expect(data![0].object_name).not.toContain(actor)
    // 実 ID は detail（view に出ない列）にだけある
    expect((data![0].detail as { actor_id: string }).actor_id).toBe(actor)

    // anon キーで読める view には detail が出ない
    const anon = createAnonClient()
    const { data: viewRows, error } = await anon
      .from('drift_alert_view')
      .select('*')
      .eq('drift_type', 'denial_anomaly')
    expect(error).toBeNull()
    for (const row of viewRows ?? []) {
      expect(Object.keys(row)).not.toContain('detail')
      expect(JSON.stringify(row)).not.toContain(actor)
    }
  })

  it('伏せ字から実 ID を引く関数は admin 以外に返さない', async () => {
    await service.rpc('record_denial_anomalies', { p_threshold: 5, p_window_seconds: 3600, p_lookback_seconds: 86400 })

    const anon = createAnonClient()
    const { error } = await anon.rpc('resolve_denial_anomaly_subject', { p_object_name: actorSubject })
    expect(error).not.toBeNull()

    // service_role は関数の中の admin 判定を通らないので null が返る（漏れない側に倒れる）
    const { data: asService } = await service.rpc('resolve_denial_anomaly_subject', {
      p_object_name: actorSubject,
    })
    expect(asService === null || asService === actor).toBe(true)
  })

  it('client ロールは検知も記録も呼べない', async () => {
    const anon = createAnonClient()
    const { error: checkError } = await anon.rpc('check_denial_anomalies', {
      p_threshold: 5,
      p_window_seconds: 3600,
      p_lookback_seconds: 86400,
    })
    expect(checkError?.code).toBe(UNAUTHORIZED)

    const { error: recordError } = await anon.rpc('record_denial_anomalies', {
      p_threshold: 5,
      p_window_seconds: 3600,
      p_lookback_seconds: 86400,
    })
    expect(recordError?.code).toBe(UNAUTHORIZED)
  })

  it('しきい値の引数が 1 未満なら例外（常に異常にする設定を作れない）', async () => {
    const { error } = await service.rpc('check_denial_anomalies', {
      p_threshold: 0,
      p_window_seconds: 3600,
      p_lookback_seconds: 86400,
    })
    expect(error).not.toBeNull()
  })
})
