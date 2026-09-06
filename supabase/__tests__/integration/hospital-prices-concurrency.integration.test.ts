// supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts
// WHY: issue #757 の 2（同時更新の整合、P-052）。hospital_prices は「施設ごとの仕入価格」で、
//      2 人が同じ行を開いて保存すると後から保存した側が相手の変更を黙って上書きしていた（lost update）。
//      リポジトリの updateHospitalPrice に楽観ロック（読み込み時の updated_at を WHERE に入れる）を
//      入れたので、本物の DB で「並列に 2 件送ると 1 件だけ成功し、負けた側は競合として拒否される」
//      「価格履歴は勝った 1 件分だけ増える」を確かめる。
//      同じ (distributor_product_id, facility_id) への並列 INSERT は UNIQUE 制約で 1 件になることも
//      ここで固定する（loan_returns の P-050 と同じ型）。
//      モックの単体テスト（route.test.ts）は 409 への写像しか見ておらず、「本当に 1 件しか通らない」
//      は実 DB でしか確かめられない。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createSeededUser,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeededUser,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'
import { getHospitalPrice, updateHospitalPrice, HOSPITAL_PRICE_CONFLICT_MESSAGE } from '@/lib/hospital-prices/repository'

// 約束カタログ（docs/agents/promise-catalog.md）: P-052 同一行の同時更新は 1 件だけ成功し競合側が拒否される
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-031 施設×代理店商品の価格は 1 行 / I-042 updated_at は更新のたびに進む
describe('hospital_prices の同時更新（楽観ロック・一意制約） [P-052 I-031 I-042]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  /** 同じ施設 A のもう 1 人（別セッション）。同一人物の 2 タブでも同じ挙動になる */
  let userA2: SeededUser

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    userA2 = await createSeededUser(serviceClient, 'rls-idor-hospital-price-user-a2', fx.facilityA.id)
  }, 60_000)

  afterAll(async () => {
    if (userA2) await serviceClient.auth.admin.deleteUser(userA2.id)
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  const inputFrom = (row: { distributorProductId: string; facilityId: string; deliveryPrice: number; updatedAt: string }, purchasePrice: number) => ({
    distributorProductId: row.distributorProductId,
    facilityId: row.facilityId,
    purchasePrice,
    deliveryPrice: row.deliveryPrice,
    expectedUpdatedAt: row.updatedAt,
  })

  it('2 人が同じ行を読んでから並列に保存すると、成功 1・競合 1 になり、価格履歴は 1 件だけ増える', async () => {
    const id = fx.hospitalPriceA.id
    const before1 = await getHospitalPrice(fx.userA.client, id)
    const before2 = await getHospitalPrice(userA2.client, id)
    expect(before1?.updatedAt).toBe(before2?.updatedAt)

    const { count: historiesBefore } = await serviceClient
      .from('price_histories')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'hospital_price')
      .eq('entity_id', id)

    const results = await Promise.allSettled([
      updateHospitalPrice(fx.userA.client, id, inputFrom(before1!, 1001)),
      updateHospitalPrice(userA2.client, id, inputFrom(before2!, 2002)),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled.length, JSON.stringify(results)).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0].reason?.message).toBe(HOSPITAL_PRICE_CONFLICT_MESSAGE)

    // 残った値は勝った側のもので、負けた側の値では上書きされていない
    const winnerPrice = (fulfilled[0] as PromiseFulfilledResult<{ purchasePrice: number }>).value.purchasePrice
    const after = await getHospitalPrice(fx.userA.client, id)
    expect(after?.purchasePrice).toBe(winnerPrice)
    expect([1001, 2002]).toContain(after?.purchasePrice)

    const { count: historiesAfter } = await serviceClient
      .from('price_histories')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'hospital_price')
      .eq('entity_id', id)
    expect((historiesAfter ?? 0) - (historiesBefore ?? 0)).toBe(1)
  })

  it('古い updatedAt で保存し直すと競合として拒否され、読み直した updatedAt なら通る', async () => {
    const id = fx.hospitalPriceA.id
    const stale = await getHospitalPrice(fx.userA.client, id)
    // 別の人が先に更新
    await updateHospitalPrice(userA2.client, id, inputFrom((await getHospitalPrice(userA2.client, id))!, 3003))

    await expect(updateHospitalPrice(fx.userA.client, id, inputFrom(stale!, 4004))).rejects.toThrow(
      HOSPITAL_PRICE_CONFLICT_MESSAGE,
    )
    const after = await getHospitalPrice(fx.userA.client, id)
    expect(after?.purchasePrice).toBe(3003)

    const fresh = await updateHospitalPrice(fx.userA.client, id, inputFrom(after!, 4004))
    expect(fresh.purchasePrice).toBe(4004)
  })

  it('expectedUpdatedAt を渡さない従来の呼び出しは無条件更新のまま（後方互換。API 経由は必ず渡す）', async () => {
    const id = fx.hospitalPriceA.id
    const current = await getHospitalPrice(fx.userA.client, id)
    const { expectedUpdatedAt: _omit, ...withoutLock } = inputFrom(current!, 5005)
    void _omit
    const updated = await updateHospitalPrice(fx.userA.client, id, withoutLock)
    expect(updated.purchasePrice).toBe(5005)
  })

  it('同じ (代理店商品, 施設) への並列 INSERT は UNIQUE 制約で 1 件だけ残る', async () => {
    const insert = (client: SeededUser['client']) =>
      client
        .from('hospital_prices')
        .insert({
          distributor_product_id: fx.distributorProductForInsert.id,
          facility_id: fx.facilityA.id,
          purchase_price: 100,
          delivery_price: 200,
        })
        .select('id')
        .single()
    const results = await Promise.all([insert(fx.userA.client), insert(userA2.client)])
    const succeeded = results.filter((r) => r.error === null)
    const failed = results.filter((r) => r.error !== null)
    expect(succeeded.length).toBe(1)
    expect(failed.length).toBe(1)
    expect(failed[0].error?.code).toBe('23505')

    const { data: rows } = await serviceClient
      .from('hospital_prices')
      .select('id')
      .eq('distributor_product_id', fx.distributorProductForInsert.id)
      .eq('facility_id', fx.facilityA.id)
    expect(rows?.length).toBe(1)
  })
})
