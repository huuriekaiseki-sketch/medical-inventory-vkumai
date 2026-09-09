// supabase/__tests__/integration/partial-loan-returns.integration.test.ts
// WHY: 2026-09-08。短貸を**分割して返す運用が実在する**ことを確認したが、
//      `loan_returns.loan_order_id` の部分 UNIQUE（20260828000001）が 1 発注 : 1 返却しか
//      許さず、「5 本借りて 3 本だけ返す」を記録する場所が無かった。
//      20260908030000 で明細どうしを紐付け（`loan_return_items.loan_order_item_id`）、
//      借りた数を超える返却をトリガーで拒否するようにした。
//
//      ここで実 DB に固定するのは 5 つ:
//        1. 同じ発注へ 2 回目の返却ができる（UNIQUE を外したこと）
//        2. 借りた数を超える返却は拒否される（23514）
//        3. 数え方（`loan_outstanding_count`）が残数を見ている
//        4. 紐付けの無い返却は残数にも上限にも関わらない（従来の経路を塞いでいない）
//        5. `loan_outstanding_count` に他施設の ID を渡しても 0（SECURITY DEFINER にしていないので
//           RLS がそのまま効く、という**関数のコメントに書いた主張**を実測で裏づける）

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

  it('未返却の数え方は施設をまたがない（他施設の ID を渡しても 0）', async () => {
    // WHY: `loan_outstanding_count` は SECURITY DEFINER にしていない（呼び出した利用者の権限で走る）。
    //      「だから RLS がそのまま効く」と関数のコメントに書いたが、**書いただけでは主張でしかない**。
    //      施設 B に未返却の発注を作ったうえで、施設 A の利用者がその施設 ID を渡して 0 になることを測る。
    const { error } = await fx.userB.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityB.id,
      p_procedure_name: '施設分離テストの発注',
      p_maker: 'テストメーカー',
      p_items: [{ jan, name: '施設分離テストの品', quantity: 3 }],
      p_client_request_id: randomUUID(),
    })
    expect(error).toBeNull()

    // 対照: 施設 B の利用者が自施設を数えると 1 件以上ある
    const { data: own, error: ownError } = await fx.userB.client.rpc('loan_outstanding_count', {
      p_facility_id: fx.facilityB.id,
    })
    expect(ownError).toBeNull()
    expect(own as number, '施設 B から自施設が数えられない（この後の 0 が空振りになる）').toBeGreaterThan(0)

    // 施設 A の利用者が施設 B の ID を渡しても 0
    const { data: crossed, error: crossedError } = await fx.userA.client.rpc('loan_outstanding_count', {
      p_facility_id: fx.facilityB.id,
    })
    expect(crossedError).toBeNull()
    expect(crossed as number, '他施設の未返却件数が数えられてしまった').toBe(0)
  })

  // WHY(E-056 の残り、2026-09-09): 1 回の返却で複数の品目を返したとき、
  //      そのうち 1 品目だけが間違いということが起きる。品目ごとに取り消せるようにした
  //      （`loan_return_items.status`）。残数と未返却の数え方が**回ごとの取り消しと同じように**
  //      明細の取り消しも除くことを、実 DB で固定する。
  it('品目ごとに取り消すと、その品目のぶんだけ残数が戻り、返し直せる', async () => {
    const before = await outstanding()
    const { orderId, itemId } = await createOrder(5)

    // 3 本 + 2 本を **1 回の返却で** 2 明細に分けて返す（合計 5 本 = 返しきる）
    const res = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        loan_order_id: orderId,
        client_request_id: randomUUID(),
      },
      p_items: [
        { jan, lot: null, ubd: null, quantity: 3, loan_order_item_id: itemId },
        { jan, lot: null, ubd: null, quantity: 2, loan_order_item_id: itemId },
      ],
    })
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    const created = res.data as RpcRow & { items: { id: string; quantity: number }[] }
    expect(await outstanding(), '5 本返したのに未返却のまま').toBe(before)

    // 2 本のほうの明細だけを取り消す
    const twoItem = created.items.find((i) => i.quantity === 2)!
    const { error: cancelError } = await serviceClient
      .from('loan_return_items')
      .update({ status: 'cancelled' })
      .eq('id', twoItem.id)
    expect(cancelError, JSON.stringify(cancelError)).toBeNull()

    expect(await outstanding(), '品目を取り消したのに未返却へ戻らない').toBe(before + 1)

    // 取り消したぶん（2 本）だけ返し直せる。3 本は返したままなので 3 本は超過で拒否される
    const tooMany = await returnItems(orderId, [{ itemId, quantity: 3 }])
    expect(tooMany.error?.code, '取り消したぶんを超えて返せてしまった').toBe(CHECK_VIOLATION)

    const again = await returnItems(orderId, [{ itemId, quantity: 2 }])
    expect(again.error, `取り消したのに返し直せない: ${JSON.stringify(again.error)}`).toBeNull()
    expect(await outstanding(), '返し直したのに未返却のまま').toBe(before)
  })

  it('取り消した品目は元に戻せない（取り消しは終端）', async () => {
    const { orderId, itemId } = await createOrder(1)
    const res = await returnItems(orderId, [{ itemId, quantity: 1 }])
    expect(res.error).toBeNull()
    const returnId = (res.data as RpcRow).id

    const { data: items } = await serviceClient
      .from('loan_return_items')
      .select('id')
      .eq('loan_return_id', returnId)
    const targetId = (items as { id: string }[])[0].id

    await serviceClient.from('loan_return_items').update({ status: 'cancelled' }).eq('id', targetId)
    const { error } = await serviceClient
      .from('loan_return_items')
      .update({ status: 'active' })
      .eq('id', targetId)
    expect(error, '取り消した明細を生き返らせられてしまった').not.toBeNull()
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
