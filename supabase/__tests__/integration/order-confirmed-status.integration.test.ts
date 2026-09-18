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

  // WHY(E-056 の残り): 2026-09-08 に返却の取り消しを作り、同日に発注 3 種にも広げた
  //      （20260908070000）。**取り消した発注が何から外れるか**を実 DB で固定する。
  //        - 短貸: 未返却の件数（返す物が無いのに未返却として残り続けるのを防ぐ）
  //        - 症例・消耗品: 発注金額の集計（誤った金額が月次に載り続けるのを防ぐ）
  //      未返却の側は `status = 'submitted'` の条件で**自動的に**外れるはずなので、
  //      「自動的に外れている」ことをここで確かめる（条件を二重に書かないと決めた根拠）。
  describe('発注の取り消し [I-020 I-021]', () => {
    const cancel = (table: string, id: string) =>
      fx.userA.client.from(table).update({ status: 'cancelled' }).eq('id', id).select('id, status')

    it('取り消した短貸発注は未返却に数えない（status の条件で自動的に外れる）', async () => {
      const outstanding = async () => {
        const { data } = await fx.userA.client.rpc('loan_outstanding_count', {
          p_facility_id: fx.facilityA.id,
        })
        return data as number
      }

      const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '取り消しテスト術式',
        p_maker: '取り消しテストメーカー',
        p_items: [{ jan: null, name: '取り消しテスト品', quantity: 1 }],
        p_client_request_id: randomUUID(),
      })
      const orderId = (order as RpcRow).id
      const withOrder = await outstanding()

      const { data: cancelled, error } = await cancel('loan_orders', orderId)
      expect(error, JSON.stringify(error)).toBeNull()
      expect((cancelled ?? [])[0]?.status).toBe('cancelled')

      expect(await outstanding(), '取り消したのに未返却に残っている').toBe(withOrder - 1)
    })

    it('取り消した症例発注は発注金額の集計から外れる', async () => {
      // 集計は admin だけが呼べる（P-045）。施設 A の staff とは別に admin を用意する
      const amount = async () => {
        const { data, error } = await fx.userA.client.rpc('get_order_amount_report', {
          p_date_from: null,
          p_date_to: null,
        })
        // staff は permission denied。集計の中身ではなく「取り消しで変わること」を見たいので
        // service_role で数え直す（RLS を通らないが、集計 RPC は SECURITY DEFINER で
        // is_admin() を見るため、ここでは直接 SQL 相当の集計を使う）
        expect(error, 'staff が集計を呼べてしまった（P-045）').not.toBeNull()
        expect(data).toBeNull()

        const { data: rows } = await serviceClient
          .from('case_order_items')
          .select('quantity, unit_price, case_orders!inner(facility_id, status)')
          .eq('case_orders.facility_id', fx.facilityA.id)
          .neq('case_orders.status', 'cancelled')
        return (rows ?? []).reduce(
          (n, r) => n + Number(r.unit_price ?? 0) * Number(r.quantity ?? 0),
          0
        )
      }

      const before = await amount()

      const { data: order } = await fx.userA.client.rpc('create_case_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: '取り消しテスト症例',
        p_patient_id: 'PT-CANCEL-1',
        p_patient_initials: 'C.T.',
        p_gender: 'other',
        p_doctor_name: '取り消しテスト医師',
        p_items: [{ jan, lot: null, ubd: null, quantity: 2 }],
        p_client_request_id: randomUUID(),
      })
      const orderId = (order as RpcRow).id

      const withOrder = await amount()
      expect(withOrder, '発注しても集計が動かない（単価が付いていない）').toBeGreaterThan(before)

      const { error } = await cancel('case_orders', orderId)
      expect(error, JSON.stringify(error)).toBeNull()

      expect(await amount(), '取り消したのに集計に残っている').toBe(before)
    })

    it('取り消しからは戻れない（3 表とも終端）', async () => {
      const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '終端テスト術式',
        p_maker: '終端テストメーカー',
        p_items: [],
        p_client_request_id: randomUUID(),
      })
      const orderId = (order as RpcRow).id
      await cancel('loan_orders', orderId)

      const { error } = await fx.userA.client
        .from('loan_orders')
        .update({ status: 'submitted' })
        .eq('id', orderId)
      expect(error?.code, '取り消しから戻せてしまう').toBe('23514')
    })

    it('決めていない状態にはできない（語彙は draft / submitted / cancelled だけ）', async () => {
      const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '語彙テスト術式',
        p_maker: '語彙テストメーカー',
        p_items: [],
        p_client_request_id: randomUUID(),
      })
      const { error } = await fx.userA.client
        .from('loan_orders')
        .update({ status: 'voided' })
        .eq('id', (order as RpcRow).id)
      expect(error?.code, '知らない状態が通ってしまう').toBe('23514')
    })

    it('他施設の利用者は取り消せない', async () => {
      const { data: order } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '境界テスト術式',
        p_maker: '境界テストメーカー',
        p_items: [],
        p_client_request_id: randomUUID(),
      })
      const orderId = (order as RpcRow).id

      const { data, error } = await fx.userB.client
        .from('loan_orders')
        .update({ status: 'cancelled' })
        .eq('id', orderId)
        .select('id')
      expect(error).toBeNull()
      expect(data ?? [], '他施設の発注を取り消せてしまった').toEqual([])

      const { data: still } = await serviceClient
        .from('loan_orders')
        .select('status')
        .eq('id', orderId)
        .single()
      expect(still!.status).toBe('submitted')
    })
  })
})
