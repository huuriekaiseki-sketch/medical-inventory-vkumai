// supabase/__tests__/integration/order-items-limit-boundary.integration.test.ts
// WHY(issue #825、2026-09-30): 1 件の発注・返却の明細の件数の上限（aidd.config.json の
//      limits.orderItemsMax = 100）は、issue #813 で **API の入口（zod）だけ**に入った。
//      RPC を PostgREST 経由で直接呼ぶ経路には無く、何万件でも通っていた。
//      20260930000000 で共有関数 `assert_items_within_limit` を足し、4 本の RPC がそれを呼ぶ。
//
//      ここで実 DB に固定するのは、4 本それぞれについて:
//        1. 上限を 1 件超える（101 件）と 23514 で止まる
//        2. ちょうど上限（100 件）は通る（**誤検知しない**。止まる側だけ測ると「常に拒否」でも緑になる）
//        3. 止まったとき、ヘッダも残らない（部分成功しない）
//      そして共通に:
//        4. 0 件・NULL は通る（既存の動きを変えない）
//
//      API の入口を通さず、施設 A の利用者のクライアントから RPC を直接呼ぶ（入口の zod は関与しない）。
//      上限の値はテストにも書かない。設定から読む（数字を 2 か所に書かない）。

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import limitsConfig from '../../../aidd.config.json'
import {
  cleanupOrderItemsRlsIdorFixtures,
  createServiceRoleClient,
  seedOrderItemsRlsIdorFixtures,
  type SeedOrderItemsRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'
const LIMIT: number = limitsConfig.limits.orderItemsMax

// 不変条件カタログ: I-038 1 件の発注・返却の明細は上限（limits.orderItemsMax）まで
describe('明細の件数の上限は RPC を直接呼んでも効く [I-038 P-013]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedOrderItemsRlsIdorFixtures

  beforeAll(async () => {
    fx = await seedOrderItemsRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupOrderItemsRlsIdorFixtures(fx)
  })

  type Table = 'case_orders' | 'loan_orders' | 'consumable_orders' | 'loan_returns'
  type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }
  type Call = (n: number) => PromiseLike<RpcResult>

  const count = async (table: Table) => {
    const { count: n } = await serviceClient
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('facility_id', fx.facilityA.id)
    return n ?? 0
  }

  // 4 本の RPC を、明細の件数だけ変えて呼ぶ。中身は正しい（施設 A の製品・消耗品）ので、
  // 止まるとしたら件数が理由。
  const rpcs: Record<Table, Call> = {
    case_orders: (n: number) =>
      fx.userA.client.rpc('create_case_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_case_datetime: new Date().toISOString(),
        p_procedure_name: '件数の上限テスト',
        p_patient_id: 'PT-LIMIT-1',
        p_patient_initials: 'L.M.',
        p_gender: 'other',
        p_doctor_name: '上限テスト医師',
        p_items: Array.from({ length: n }, () => ({ jan: fx.jan, lot: null, ubd: null, quantity: 1 })),
        p_client_request_id: randomUUID(),
      }),
    loan_orders: (n: number) =>
      fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '件数の上限テスト',
        p_maker: 'テストメーカー',
        p_items: Array.from({ length: n }, () => ({ jan: null, name: '上限テスト', quantity: 1 })),
        p_client_request_id: randomUUID(),
      }),
    consumable_orders: (n: number) =>
      fx.userA.client.rpc('create_consumable_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_items: Array.from({ length: n }, () => ({ consumable_id: fx.consumableId, quantity: 1 })),
        p_client_request_id: randomUUID(),
      }),
    loan_returns: (n: number) =>
      fx.userA.client.rpc('create_loan_return_atomic', {
        p_header: {
          facility_id: fx.facilityA.id,
          return_datetime: new Date().toISOString(),
          loan_order_id: null,
          client_request_id: randomUUID(),
        },
        p_items: Array.from({ length: n }, () => ({ jan: fx.jan, lot: null, ubd: null, quantity: 1 })),
      }),
  }

  for (const [table, call] of Object.entries(rpcs) as [Table, Call][]) {
    describe(table, () => {
      it(`上限を 1 件超えると 23514 で止まり、ヘッダも残らない`, async () => {
        const before = await count(table)
        const res = await call(LIMIT + 1)
        expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
        expect(res.error?.message).toMatch(/too many items/)
        // 文言に「何件までか」が入る（RPC を直接呼んだ人が、直し方を読める）
        expect(res.error?.message).toContain(`limit ${LIMIT}`)
        expect(await count(table), '件数で止まったのにヘッダだけ残っている').toBe(before)
      })

      it(`ちょうど上限の件数なら通る（誤検知しない）`, async () => {
        // WHY(C-021 の対): 止まる側だけを測ると「常に拒否」の実装でも緑になる
        const res = await call(LIMIT)
        expect(res.error, JSON.stringify(res.error)).toBeNull()
        const created = res.data as { items: unknown[] }
        expect(created.items).toHaveLength(LIMIT)
      })
    })
  }

  it('0 件は通る（既存の動きを変えない）', async () => {
    const res = await rpcs.loan_orders(0)
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    expect((res.data as { items: unknown[] }).items).toHaveLength(0)
  })

  it('NULL は通る（既存の RPC は COALESCE で空として扱う）', async () => {
    const res = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: '件数の上限テスト（NULL）',
      p_maker: 'テストメーカー',
      p_items: null,
      p_client_request_id: randomUUID(),
    })
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    expect((res.data as { items: unknown[] }).items).toHaveLength(0)
  })

  it('共有関数は利用者から直接は呼べない（RPC の中でだけ動く）', async () => {
    // WHY: assert_facility_owns と同じ扱い。利用者に見せる API ではないので REVOKE してある
    const res = await fx.userA.client.rpc('assert_items_within_limit', { p_items: [] })
    expect(res.error, '利用者が共有関数を直接呼べてしまう').not.toBeNull()
  })
})
