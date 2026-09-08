// supabase/__tests__/integration/order-confirmed-status.integration.test.ts
// WHY: E-052。発注・返却の状態を draft から進める経路が**アプリのどこにも無かった**ので、
//      「未返却」バッジ・返却フォームの対象選択・ダッシュボードの未返却件数の 3 つが
//      到達不能なまま死んでいた（2026-09-08 実測: loan_orders 13 件すべて draft・submitted 0 件）。
//      2026-09-08 に **作成＝確定** と決めて、4 つの RPC が submitted / returned で作るようにした
//      （20260908020000）。ここで実 DB に固定するのは 3 つ:
//        1. 画面の経路（RPC）で作ると確定した状態になる
//        2. **列の既定値は draft のまま**（RPC を通らない書き込みまで巻き込んでいない）
//        3. 未返却の数え方が紐付けベースで動く（紐付いた返却があれば数から外れる）
//
//      1 が壊れると 3 機能が黙って死ぬ。2 が壊れると「下書き保存を後から足す」道が塞がる。

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

type RpcRow = { id: string; status: string }

describe('発注・返却は確定した状態で作られる（E-052） [I-020 I-021]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let jan: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  it('症例発注は submitted で作られる', async () => {
    const { data, error } = await fx.userA.client.rpc('create_case_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: '確定テスト手技',
      p_patient_id: 'PT-CONF-1',
      p_patient_initials: 'C.F.',
      p_gender: 'other',
      p_doctor_name: 'テスト医師',
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('submitted')
  })

  it('短貸発注は submitted で作られる', async () => {
    const { data, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: '確定テスト術式',
      p_maker: '確定テストメーカー',
      p_items: [{ jan: null, name: '確定テスト品', quantity: 1 }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('submitted')
  })

  it('消耗品発注は submitted で作られる', async () => {
    const { data: consumable } = await serviceClient
      .from('consumables')
      .insert({ facility_id: fx.facilityA.id, name: '確定テスト消耗品', purpose: 'test' })
      .select('id')
      .single()
    const { data, error } = await fx.userA.client.rpc('create_consumable_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_items: [{ consumable_id: consumable!.id, quantity: 1 }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('submitted')
  })

  it('短貸返却は returned で作られる', async () => {
    const { data, error } = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        client_request_id: randomUUID(),
      },
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
    })
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('returned')
  })

  // WHY: RPC 側だけを変えたことの確認。既定値まで変えていたら「下書き保存を後から足す」道が塞がる
  it.each([
    ['case_orders', { case_datetime: new Date().toISOString(), procedure_name: 'x', patient_id: 'p', patient_initials: 'p', gender: 'other', doctor_name: 'd' }],
    ['consumable_orders', {}],
    ['loan_orders', { procedure_name: 'x', maker: 'm' }],
  ])('%s の列の既定値は draft のまま（RPC を通らない書き込みは変えていない）', async (table, extra) => {
    const { data, error } = await serviceClient
      .from(table)
      .insert({ facility_id: fx.facilityA.id, ...extra })
      .select('id, status')
      .single()
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('draft')
    await serviceClient.from(table).delete().eq('id', (data as RpcRow).id)
  })

  it('loan_returns の列の既定値も draft のまま', async () => {
    const { data, error } = await serviceClient
      .from('loan_returns')
      .insert({ facility_id: fx.facilityA.id, return_datetime: new Date().toISOString() })
      .select('id, status')
      .single()
    expect(error).toBeNull()
    expect((data as RpcRow).status).toBe('draft')
    await serviceClient.from('loan_returns').delete().eq('id', (data as RpcRow).id)
  })

  // WHY: ダッシュボードの未返却件数（src/lib/dashboard/loan-outstanding.ts）と同じ問い合わせ。
  //      埋め込みの anti-join が本当に親を絞ることを実 DB で確かめる（外すと件数が水増しされる）
  it('未返却の数え方: 紐付いた返却がある発注は数から外れる', async () => {
    const countOutstanding = async () => {
      const { count, error } = await serviceClient
        .from('loan_orders')
        .select('id, loan_returns!left(id)', { count: 'exact', head: true })
        .eq('facility_id', fx.facilityA.id)
        .eq('status', 'submitted')
        .is('loan_returns', null)
      expect(error).toBeNull()
      return count ?? 0
    }

    const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: '未返却カウント術式',
      p_maker: '未返却カウントメーカー',
      p_items: [{ jan: null, name: '未返却カウント品', quantity: 1 }],
      p_client_request_id: randomUUID(),
    })
    const orderId = (order as RpcRow).id
    const withOrder = await countOutstanding()

    const { error: returnError } = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        loan_order_id: orderId,
        client_request_id: randomUUID(),
      },
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
    })
    expect(returnError).toBeNull()

    expect(await countOutstanding(), '紐付いた返却を作っても件数が減らない').toBe(withOrder - 1)
  })
})
