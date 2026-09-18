// supabase/__tests__/integration/order-idempotency.integration.test.ts
// WHY: issue #757 の 2（発注の冪等性、P-053）。発注・返却の作成 RPC は呼ばれるたびに新しい行を
//      作っていたので、応答が返る前の通信断や二重クリックで同じ発注が 2 件できた。
//      画面が 1 回だけ作る client_request_id を DB が「施設 × 鍵は 1 行」の UNIQUE で守り、
//      RPC は同じ鍵の再送で既存の行を返す。ここでは本物の DB で
//      「同じ鍵で 2 回 → 1 行」「同じ鍵で 2 件同時 → 1 行（両方成功）」「鍵なしは従来どおり 2 行」
//      「鍵は施設ごと（他施設の鍵で自施設の発注を再生できない）」「P-050（同じ短貸発注への
//      2 回目の返却）は鍵があっても従来どおり 23505」を固定する。

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createSeededUser,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeededUser,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const UNIQUE_VIOLATION = '23505'

type RpcOrder = { id: string; client_request_id: string | null; replayed: boolean; items: { id: string }[] }

// 約束カタログ（docs/agents/promise-catalog.md）: P-053 同じ client_request_id の再送は新しい発注を作らない
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-034 施設 × client_request_id の発注・返却は 1 行
describe('発注・返却 RPC の冪等性（client_request_id） [P-053 I-034]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  /** 同じ施設 A のもう 1 人（別セッション）。同一人物の 2 タブでも同じ挙動になる */
  let userA2: SeededUser
  let jan: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    userA2 = await createSeededUser(serviceClient, 'idempotency-user-a2', fx.facilityA.id)
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    jan = data!.jan as string
  }, 60_000)

  afterAll(async () => {
    if (userA2) await serviceClient.auth.admin.deleteUser(userA2.id)
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  const caseOrderArgs = (key: string | null, procedureName = '冪等性テスト') => ({
    p_facility_id: fx.facilityA.id,
    p_case_datetime: new Date().toISOString(),
    p_procedure_name: procedureName,
    p_patient_id: 'PT-IDEM-1',
    p_patient_initials: 'I.D.',
    p_gender: 'other',
    p_doctor_name: 'テスト医師',
    p_items: [{ jan, lot: null, ubd: null, quantity: 2 }],
    ...(key ? { p_client_request_id: key } : {}),
  })

  const countRows = async (table: string, facilityId: string, key: string) => {
    const { count } = await serviceClient
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('facility_id', facilityId)
      .eq('client_request_id', key)
    return count ?? 0
  }

  it('症例発注: 同じ鍵で 2 回呼ぶと 2 回目は既存の行を返し（replayed: true）、行も明細も増えない', async () => {
    const key = randomUUID()
    const first = await fx.userA.client.rpc('create_case_order_atomic', caseOrderArgs(key))
    expect(first.error).toBeNull()
    const firstOrder = first.data as RpcOrder
    expect(firstOrder.replayed).toBe(false)
    expect(firstOrder.client_request_id).toBe(key)
    expect(firstOrder.items).toHaveLength(1)

    // 再送は内容が違っても鍵で判定する（画面は同じ内容を送るが、鍵が同じなら新しい行は作らない）
    const second = await fx.userA.client.rpc('create_case_order_atomic', caseOrderArgs(key, '再送で違う手技名'))
    expect(second.error).toBeNull()
    const secondOrder = second.data as RpcOrder
    expect(secondOrder.id).toBe(firstOrder.id)
    expect(secondOrder.replayed).toBe(true)
    expect(secondOrder.items).toHaveLength(1)

    expect(await countRows('case_orders', fx.facilityA.id, key)).toBe(1)
    const { count: items } = await serviceClient
      .from('case_order_items')
      .select('id', { count: 'exact', head: true })
      .eq('case_order_id', firstOrder.id)
    expect(items).toBe(1)
  })

  it('短貸発注: 同じ鍵で 2 件同時に送ると両方成功し、行は 1 件、id は同じ', async () => {
    const key = randomUUID()
    const call = (client: SeededUser['client']) =>
      client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '同時送信テスト',
        p_maker: 'テストメーカー',
        p_items: [{ jan: null, name: '同時送信品', quantity: 1 }],
        p_client_request_id: key,
      })
    const results = await Promise.all([call(fx.userA.client), call(userA2.client)])
    expect(results.map((r) => r.error), JSON.stringify(results.map((r) => r.error))).toEqual([null, null])
    const ids = results.map((r) => (r.data as RpcOrder).id)
    expect(ids[0]).toBe(ids[1])
    const replayed = results.map((r) => (r.data as RpcOrder).replayed).sort()
    // どちらが先かは決まらないが、成功 1（新規）・再生 1 になる
    expect(replayed).toEqual([false, true])

    expect(await countRows('loan_orders', fx.facilityA.id, key)).toBe(1)
    const { count: items } = await serviceClient
      .from('loan_order_items')
      .select('id', { count: 'exact', head: true })
      .eq('loan_order_id', ids[0])
    expect(items).toBe(1)
  })

  it('消耗品発注: 同じ鍵で 2 回呼んでも 1 行', async () => {
    const { data: consumable } = await serviceClient
      .from('consumables')
      .insert({ facility_id: fx.facilityA.id, name: '冪等性テスト消耗品', purpose: 'test' })
      .select('id')
      .single()
    const key = randomUUID()
    const args = {
      p_facility_id: fx.facilityA.id,
      p_items: [{ consumable_id: consumable!.id, quantity: 3 }],
      p_client_request_id: key,
    }
    const first = await fx.userA.client.rpc('create_consumable_order_atomic', args)
    const second = await fx.userA.client.rpc('create_consumable_order_atomic', args)
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect((second.data as RpcOrder).id).toBe((first.data as RpcOrder).id)
    expect(await countRows('consumable_orders', fx.facilityA.id, key)).toBe(1)
  })

  it('返却: p_header.client_request_id で同じ鍵を送ると 1 行', async () => {
    const key = randomUUID()
    const args = {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        loan_order_id: null,
        client_request_id: key,
      },
      p_items: [{ jan, lot: null, ubd: null, quantity: 1 }],
    }
    const first = await fx.userA.client.rpc('create_loan_return_atomic', args)
    const second = await fx.userA.client.rpc('create_loan_return_atomic', args)
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect((second.data as RpcOrder).id).toBe((first.data as RpcOrder).id)
    expect((second.data as RpcOrder).replayed).toBe(true)
    expect(await countRows('loan_returns', fx.facilityA.id, key)).toBe(1)
  })

  it('返却: 別の鍵なら同じ短貸発注へもう一度返却できる（分割返却。鍵の再送とは別物）', async () => {
    const { data: loanOrder } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: 'P-050 との併存テスト',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    const loanOrderId = (loanOrder as RpcOrder).id
    const header = (key: string) => ({
      facility_id: fx.facilityA.id,
      return_datetime: new Date().toISOString(),
      loan_order_id: loanOrderId,
      client_request_id: key,
    })
    const first = await fx.userA.client.rpc('create_loan_return_atomic', { p_header: header(randomUUID()), p_items: [] })
    expect(first.error).toBeNull()
    // WHY(2026-09-08 に変わった): loan_order_id の部分 UNIQUE は分割返却のために外した
    //      （20260908030000）。別の鍵で同じ短貸発注へもう一度返却するのは**正しい操作**になり、
    //      止めるのは「借りた数を超えたとき」だけになった（P-050 の書き換え）。
    const second = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        loan_order_id: loanOrderId,
        client_request_id: randomUUID(),
      },
      p_items: [],
    })
    expect(second.error, JSON.stringify(second.error)).toBeNull()
  })

  it('鍵を渡さない従来の呼び出しは毎回新しい行を作る（後方互換。API 経由の画面は必ず渡す）', async () => {
    const first = await fx.userA.client.rpc('create_case_order_atomic', caseOrderArgs(null, '鍵なし'))
    const second = await fx.userA.client.rpc('create_case_order_atomic', caseOrderArgs(null, '鍵なし'))
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect((second.data as RpcOrder).id).not.toBe((first.data as RpcOrder).id)
    expect((second.data as RpcOrder).client_request_id).toBeNull()
  })

  it('鍵は施設ごと: 他施設の利用者が同じ鍵で送っても施設 A の発注は再生されず、自施設に新しい行ができる', async () => {
    const key = randomUUID()
    const a = await fx.userA.client.rpc('create_case_order_atomic', caseOrderArgs(key, '施設 A の発注'))
    expect(a.error).toBeNull()
    const b = await fx.userB.client.rpc('create_case_order_atomic', {
      ...caseOrderArgs(key, '施設 B の発注'),
      p_facility_id: fx.facilityB.id,
    })
    expect(b.error).toBeNull()
    expect((b.data as RpcOrder).id).not.toBe((a.data as RpcOrder).id)
    expect((b.data as RpcOrder).replayed).toBe(false)
    // 施設 B の利用者が施設 A の facility_id で再生を試みても、認可で先に止まる（鍵の存在を探れない）
    const probe = await fx.userB.client.rpc('create_case_order_atomic', caseOrderArgs(key, '探り'))
    expect(probe.error?.message).toContain('forbidden')
    expect(await countRows('case_orders', fx.facilityA.id, key)).toBe(1)
    expect(await countRows('case_orders', fx.facilityB.id, key)).toBe(1)
  })

  it('service_role でも同じ施設 × 同じ鍵の 2 行目は UNIQUE で入らない（RPC を迂回しても 1 行）', async () => {
    const key = randomUUID()
    const row = { facility_id: fx.facilityA.id, client_request_id: key }
    const first = await serviceClient.from('consumable_orders').insert(row)
    const second = await serviceClient.from('consumable_orders').insert(row)
    expect(first.error).toBeNull()
    expect(second.error?.code).toBe(UNIQUE_VIOLATION)
  })
})
