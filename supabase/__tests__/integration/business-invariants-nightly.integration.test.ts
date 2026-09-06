// supabase/__tests__/integration/business-invariants-nightly.integration.test.ts
// WHY: issue #757 の 9。夜間検査は「違反を作ると検知され、直すと resolved になる」を実 DB で見ないと
//      信用できない（検知関数が常に 0 件を返していても静的テストは通る）。
//      I-050: 貸出 1 個に対し返却 2 個を作り、check → record → schema_drift_log に detected、
//             返却を消して record → resolved。
//      I-051: 素の DB では NOT VALID 制約の違反行が 0 件（違反行は制約が新規 INSERT を止めるため
//             テストから作れない。既存行の検査であることの限界をここに記す）。
//      権限: client からは 42501。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

type InvariantRow = { invariant_id: string; object_name: string; detail: Record<string, unknown> }

describe('不変条件の夜間検査（check / record_business_invariants） [I-050 I-051]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  // loan_order_items.jan は products(jan) への FK（20260714000004）。シード済み製品の JAN を使う
  let jan: string
  let orderId: string
  let returnId: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  it('client ロールからは呼べない（42501）', async () => {
    const { error } = await fx.userA.client.rpc('check_business_invariants')
    expect(error?.code).toBe('42501')
    const { error: rec } = await fx.userA.client.rpc('record_business_invariants')
    expect(rec?.code).toBe('42501')
  })

  it('I-050: 貸出 1 個に対し返却 2 個を作ると検知され、record で schema_drift_log に detected として残る', async () => {
    const { data: order, error: orderError } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: '夜間検査テスト',
      p_maker: 'テストメーカー',
      p_items: [{ jan, name: '貸出品', quantity: 1 }],
    })
    expect(orderError).toBeNull()
    orderId = (order as { id: string }).id

    const { data: ret, error: retError } = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: { facility_id: fx.facilityA.id, return_datetime: new Date().toISOString(), loan_order_id: orderId },
      p_items: [{ jan, lot: null, ubd: null, quantity: 2 }],
    })
    expect(retError).toBeNull()
    returnId = (ret as { id: string }).id

    const { data, error } = await serviceClient.rpc('check_business_invariants')
    expect(error).toBeNull()
    const rows = (data ?? []) as InvariantRow[]
    const hit = rows.find((r) => r.invariant_id === 'I-050' && r.object_name === `${orderId}:${jan}`)
    expect(hit, JSON.stringify(rows)).toBeDefined()
    expect(hit?.detail).toMatchObject({ jan, returned: 2, loaned: 1 })

    const { error: recordError } = await serviceClient.rpc('record_business_invariants')
    expect(recordError).toBeNull()
    const { data: logged } = await serviceClient
      .from('schema_drift_log')
      .select('event_kind, resolved_at, detail')
      .eq('drift_type', 'invariant_violation')
      .eq('object_name', `I-050:${orderId}:${jan}`)
      .single()
    expect(logged).toMatchObject({ event_kind: 'detected', resolved_at: null })

    // 2 回目の record で重複しない（冪等）
    await serviceClient.rpc('record_business_invariants')
    const { count } = await serviceClient
      .from('schema_drift_log')
      .select('id', { count: 'exact', head: true })
      .eq('drift_type', 'invariant_violation')
      .eq('object_name', `I-050:${orderId}:${jan}`)
    expect(count).toBe(1)
  })

  it('返却を消して record すると resolved になり、record_schema_drift は invariant 行に触れない', async () => {
    // 先に record_schema_drift を回しても invariant の detected 行は resolved にならない
    await serviceClient.rpc('record_schema_drift')
    const { data: stillOpen } = await serviceClient
      .from('schema_drift_log')
      .select('event_kind')
      .eq('drift_type', 'invariant_violation')
      .eq('object_name', `I-050:${orderId}:${jan}`)
      .single()
    expect(stillOpen?.event_kind).toBe('detected')

    await serviceClient.from('loan_returns').delete().eq('id', returnId)
    await serviceClient.rpc('record_business_invariants')
    const { data: resolved } = await serviceClient
      .from('schema_drift_log')
      .select('event_kind, resolved_at')
      .eq('drift_type', 'invariant_violation')
      .eq('object_name', `I-050:${orderId}:${jan}`)
      .single()
    expect(resolved?.event_kind).toBe('resolved')
    expect(resolved?.resolved_at).not.toBeNull()
  })

  it('I-051: 素の DB では NOT VALID 制約に違反する既存行が無い（違反があれば VALIDATE 前に直す合図）', async () => {
    const { data } = await serviceClient.rpc('check_business_invariants')
    const rows = (data ?? []) as InvariantRow[]
    expect(rows.filter((r) => r.invariant_id === 'I-051')).toEqual([])
  })
})
