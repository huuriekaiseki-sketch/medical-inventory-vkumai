// supabase/__tests__/integration/loan-order-cancel-boundary.integration.test.ts
// WHY(2026-09-09、人の業務判断): 発注の取り消し（E-056、20260908070000）は**返却との噛み合わせを
//      決めていなかった**。実測すると「2 本借りて 2 本返した発注」をそのまま取り消せて、
//      返却の行は `returned` のまま取り消された発注を指し続けていた。
//
//      人が決めたのは 2 つで、**向きが違う**:
//        - 返却が残っている発注は**取り消せない**（物が動いた事実は消せない。先に返却を取り消す）
//        - 取り消し済みの発注へ**あとから返却は作れてよい**（取り消した後に返ってきたときの記録先）
//
//      つまりこれは「取り消し済みの発注には返却が無い」という不変条件ではなく、
//      **取り消すという遷移の条件**。片方だけ測ると、逆向きを塞いだことに気づけない（C-024）。
//
// ここで実 DB に固定するのは 6 つ:
//   1. 返却がある発注は取り消せない（23514・文言つき）
//   2. 返却を取り消せば、その発注は取り消せる（通す向き。対照）
//   3. 明細だけを取り消しても、生きた明細が 1 つでも残っていれば取り消せない
//   4. header の紐付けが無く**明細だけがこの発注を指す**返却でも止まる（残数の数え方と揃っている）
//   5. 返却が 1 件も無ければ取り消せる（誤検知しない）
//   6. 取り消し済みの発注へ、あとから返却を作れる（**塞いでいないこと**の対照）

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'

// 不変条件カタログ: I-022 返却が残っている短貸発注は取り消せない
describe('返却が残っている短貸発注は取り消せない [I-022 P-050]', () => {
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

  /** 数量 n の明細を 1 つ持つ短貸発注を作る */
  async function createOrder(quantity: number) {
    const { data, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: `取り消し境界-${randomUUID().slice(0, 8)}`,
      p_maker: '取り消し境界メーカー',
      p_items: [{ jan, name: '取り消し境界品', quantity }],
      p_client_request_id: randomUUID(),
    })
    expect(error, JSON.stringify(error)).toBeNull()
    const order = data as { id: string; items: { id: string }[] }
    return { orderId: order.id, itemId: order.items[0].id }
  }

  /** 返却を 1 件作る。`orderId` を渡さなければ header の紐付けは付かない */
  async function createReturn(orderId: string | null, itemId: string | null, quantity: number) {
    const { data, error } = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        ...(orderId ? { loan_order_id: orderId } : {}),
        client_request_id: randomUUID(),
      },
      p_items: [{ jan, lot: null, ubd: null, quantity, ...(itemId ? { loan_order_item_id: itemId } : {}) }],
    })
    expect(error, JSON.stringify(error)).toBeNull()
    const ret = data as { id: string; items: { id: string }[] }
    return { returnId: ret.id, returnItemId: ret.items[0].id }
  }

  const cancelOrder = (orderId: string) =>
    fx.userA.client
      .from('loan_orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      .eq('facility_id', fx.facilityA.id)
      .select('id, status')

  const cancelReturn = (returnId: string) =>
    fx.userA.client.from('loan_returns').update({ status: 'cancelled' }).eq('id', returnId).select('id')

  const cancelReturnItem = (returnItemId: string) =>
    fx.userA.client.from('loan_return_items').update({ status: 'cancelled' }).eq('id', returnItemId).select('id')

  it('返却がある発注は取り消せない', async () => {
    const { orderId, itemId } = await createOrder(2)
    await createReturn(orderId, itemId, 2)

    const res = await cancelOrder(orderId)
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
    expect(res.error?.message, '何をすれば直せるかが読めない').toMatch(/has active returns/)

    // 拒まれた側は本当に変わっていない（0 行で「成功」に見えていないこと）
    const { data: after } = await serviceClient.from('loan_orders').select('status').eq('id', orderId).single()
    expect(after!.status).toBe('submitted')
  })

  it('返却を取り消せば、その発注は取り消せる（通す向き）', async () => {
    const { orderId, itemId } = await createOrder(2)
    const { returnId } = await createReturn(orderId, itemId, 2)

    const blocked = await cancelOrder(orderId)
    expect(blocked.error?.code).toBe(CHECK_VIOLATION)

    const undo = await cancelReturn(returnId)
    expect(undo.error, JSON.stringify(undo.error)).toBeNull()

    const res = await cancelOrder(orderId)
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    expect(res.data?.[0]?.status).toBe('cancelled')
  })

  it('明細を 1 つ取り消しても、生きた明細が残っていれば取り消せない', async () => {
    const { orderId, itemId } = await createOrder(3)
    const first = await createReturn(orderId, itemId, 1)
    await createReturn(orderId, itemId, 1)

    const undo = await cancelReturnItem(first.returnItemId)
    expect(undo.error, JSON.stringify(undo.error)).toBeNull()

    const res = await cancelOrder(orderId)
    expect(res.error?.code, '1 件取り消しただけで取り消せてしまった').toBe(CHECK_VIOLATION)
  })

  it('header の紐付けが無く、明細だけがこの発注を指す返却でも止まる', async () => {
    // WHY: 残数（loan_outstanding_count）は**明細の紐付け**で数えている。
    //      header だけを見て判定すると、残数を減らした返却があるのに取り消せてしまう
    const { orderId, itemId } = await createOrder(2)
    await createReturn(null, itemId, 2)

    const res = await cancelOrder(orderId)
    expect(res.error?.code, JSON.stringify(res.error)).toBe(CHECK_VIOLATION)
  })

  it('返却が 1 件も無ければ取り消せる（誤検知しない）', async () => {
    const { orderId } = await createOrder(1)
    const res = await cancelOrder(orderId)
    expect(res.error, JSON.stringify(res.error)).toBeNull()
    expect(res.data?.[0]?.status).toBe('cancelled')
  })

  it('紐付けの無い返却は、他人の発注の取り消しを止めない', async () => {
    // WHY(C-021 の対): 止まる側だけを測ると「常に止まる」実装でも緑になる。
    //      **関係の無い返却では止まらない**ことを対で置く
    const { orderId: other, itemId: otherItem } = await createOrder(1)
    await createReturn(other, otherItem, 1)

    const { orderId } = await createOrder(1)
    const res = await cancelOrder(orderId)
    expect(res.error, '無関係な返却で止まった').toBeNull()
  })

  it('取り消し済みの発注へ、あとから返却を作れる（塞いでいないことの対照）', async () => {
    // WHY(2026-09-09 の判断): 逆向きは**許す**と決めた。取り消したあとに物が返ってきたときの
    //      記録先が要るため。ここを塞いでいないことを対で固定する（C-024）
    const { orderId, itemId } = await createOrder(2)
    const cancelled = await cancelOrder(orderId)
    expect(cancelled.error, JSON.stringify(cancelled.error)).toBeNull()

    const { data, error } = await fx.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fx.facilityA.id,
        return_datetime: new Date().toISOString(),
        loan_order_id: orderId,
        client_request_id: randomUUID(),
      },
      p_items: [{ jan, lot: null, ubd: null, quantity: 1, loan_order_item_id: itemId }],
    })
    expect(error, JSON.stringify(error)).toBeNull()
    expect(data).toBeTruthy()
  })
})
