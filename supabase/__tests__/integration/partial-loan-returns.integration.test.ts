// supabase/__tests__/integration/partial-loan-returns.integration.test.ts
// WHY: 2026-09-08。短貸を**分割して返す運用が実在する**ことを確認したが、
//      `loan_returns.loan_order_id` の部分 UNIQUE（20260828000001）が 1 発注 : 1 返却しか
//      許さず、「5 本借りて 3 本だけ返す」を記録する場所が無かった。
//      20260908030000 で明細どうしを紐付け（`loan_return_items.loan_order_item_id`）、
//      借りた数を超える返却をトリガーで拒否するようにした。
//
//      ここで実 DB に固定するのは 4 つ:
//        1. 同じ発注へ 2 回目の返却ができる（UNIQUE を外したこと）
//        2. 借りた数を超える返却は拒否される（23514）
//        3. 数え方（`loan_outstanding_count`）が残数を見ている
//        4. 紐付けの無い返却は残数にも上限にも関わらない（従来の経路を塞いでいない）

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'

type RpcRow = { id: string; status: string }

// 不変条件カタログ: I-030 分割して返せるが、明細ごとに借りた数を超えない
describe('分割返却と過剰返却の拒否 [I-030 P-050]', () => {
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

  /** 数量 n の明細を 1 つ持つ短貸発注を作り、発注 ID と明細 ID を返す */
  async function createOrder(quantity: number) {
    const { data, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: `分割返却テスト-${randomUUID().slice(0, 8)}`,
      p_maker: '分割返却テストメーカー',
      p_items: [{ jan, name: '分割返却テスト品', quantity }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    const order = data as RpcRow & { items: { id: string }[] }
    expect(order.items).toHaveLength(1)
    return { orderId: order.id, itemId: order.items[0].id }
  }

  /** 返却を 1 件作る。紐付け先の明細と数量を指定する */
  function returnItems(orderId: string | null, items: { itemId: string | null; quantity: number }[]) {
    return fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        ...(orderId ? { loan_order_id: orderId } : {}),
        client_request_id: randomUUID(),
      },
      p_items: items.map((i) => ({
        jan,
        lot: null,
        ubd: null,
        quantity: i.quantity,
        ...(i.itemId ? { loan_order_item_id: i.itemId } : {}),
      })),
    })
  }

  const outstanding = async () => {
    const { data, error } = await fx.userA.client.rpc('loan_outstanding_count', {
      p_facility_id: fx.facilityA.id,
    })
    expect(error).toBeNull()
    return data as number
  }

  it('5 本の発注を 3 本 → 2 本の 2 回に分けて返せる', async () => {
    const before = await outstanding()
    const { orderId, itemId } = await createOrder(5)
    expect(await outstanding(), '発注しても未返却が増えない').toBe(before + 1)

    const first = await returnItems(orderId, [{ itemId, quantity: 3 }])
    expect(first.error, JSON.stringify(first.error)).toBeNull()
    expect(await outstanding(), '3 本返した時点で未返却から外れてしまった').toBe(before + 1)

    // WHY(2 回目): 20260828000001 の部分 UNIQUE があったころは、ここが 23505 で弾かれていた
    const second = await returnItems(orderId, [{ itemId, quantity: 2 }])
    expect(second.error, JSON.stringify(second.error)).toBeNull()
    expect(await outstanding(), '全部返したのに未返却のまま').toBe(before)
  })

  it('借りた数を超える返却は拒否される（1 回で超える）', async () => {
    const { orderId, itemId } = await createOrder(2)
    const res = await returnItems(orderId, [{ itemId, quantity: 3 }])
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
  })

  it('借りた数を超える返却は拒否される（分割して合計で超える）', async () => {
    // WHY: 1 回ずつは上限内でも合計で超える形が本命。合計を数えていないと通ってしまう
    const { orderId, itemId } = await createOrder(3)
    const first = await returnItems(orderId, [{ itemId, quantity: 2 }])
    expect(first.error).toBeNull()

    const second = await returnItems(orderId, [{ itemId, quantity: 2 }])
    expect(second.error?.code, JSON.stringify(second.error)).toBe(CHECK_VIOLATION)

    // 拒否された分は残っていない（残り 1 本のまま）
    const third = await returnItems(orderId, [{ itemId, quantity: 1 }])
    expect(third.error, JSON.stringify(third.error)).toBeNull()
  })

  it('ちょうど借りた数なら通る（境界の反対側）', async () => {
    const { orderId, itemId } = await createOrder(4)
    const res = await returnItems(orderId, [{ itemId, quantity: 4 }])
    expect(res.error, JSON.stringify(res.error)).toBeNull()
  })

  it('紐付けの無い返却は残数にも上限にも関わらない（従来の経路を塞いでいない）', async () => {
    const before = await outstanding()
    const { orderId, itemId } = await createOrder(1)
    expect(await outstanding()).toBe(before + 1)

    // 対象を選ばない返却を何件作っても残数は減らない
    for (let i = 0; i < 3; i += 1) {
      const res = await returnItems(null, [{ itemId: null, quantity: 99 }])
      expect(res.error, JSON.stringify(res.error)).toBeNull()
    }
    expect(await outstanding(), '紐付けの無い返却で未返却が減った').toBe(before + 1)

    // 紐付けた 1 本で外れる
    const linked = await returnItems(orderId, [{ itemId, quantity: 1 }])
    expect(linked.error).toBeNull()
    expect(await outstanding()).toBe(before)
  })

  it('他施設の発注明細には紐付けられない', async () => {
    // WHY: loan_order_item_id はクライアントから来る値。施設をまたいで紐付けられると、
    //      他施設の発注の残数を自施設の返却で動かせてしまう
    const { data, error } = await fx.userB.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityB.id,
      p_procedure_name: '他施設の発注',
      p_maker: 'テストメーカー',
      p_items: [{ jan, name: '他施設の品', quantity: 5 }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()
    const foreignItemId = (data as RpcRow & { items: { id: string }[] }).items[0].id

    const res = await returnItems(null, [{ itemId: foreignItemId, quantity: 1 }])
    expect(res.error, '他施設の発注明細に紐付けられてしまった').not.toBeNull()
  })
})
