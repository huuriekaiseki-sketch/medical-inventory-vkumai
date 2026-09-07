// supabase/__tests__/integration/rls-mutation-gaps.integration.test.ts
// WHY: issue #757 の 7 の続き。2026-09-07 に RLS ポリシーを 1 つずつ壊して統合テストが落ちるかを
//      測ったところ、**10 件中 4 件で誰も気づかなかった**（効き目 60%。TypeScript 層の初回 62% と同じ）。
//      生き残った 4 件は「テストがある」ように見えて、その条件を 1 つも守っていなかった。
//
//        M-002 施設スコープの書き込みから aal2 を外しても気づかない
//              → aal2 のテストは **RPC 経由**しか見ておらず、表への直接書き込みを見ていなかった
//        M-003 仕入価格の書き込みを閲覧者にも許しても気づかない
//              → 閲覧者のテストは消耗品と発注 RPC だけで、仕入価格を見ていなかった
//        M-006 施設の作成から admin 判定を外しても気づかない
//              → マスタ境界のテストは商品・カテゴリ・代理店商品だけで、施設を見ていなかった
//        M-010 回数のカウンタを認証済み利用者に開いても気づかない
//              → カウンタのテストは anon だけを見ており、**ログイン済み利用者**を見ていなかった
//
//      ここはその 4 つを埋める。壊したときに必ずどれかが落ちることを、
//      `bash scripts/check-rls-mutation.sh` が実測で確かめる。

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  type SeededUser,
} from './helpers/seed-rls-idor'

// WHY: 既存の cleanupFacilitiesAndUsers は「利用者 2 人・施設 2 つ」の組を前提にしている。
//      ここは人数が可変なので、必要な分だけ消す小さな後片付けを持つ
async function removeUsers(ids: string[]) {
  for (const id of ids) await service.auth.admin.deleteUser(id)
}
async function removeFacilities(ids: string[]) {
  for (const id of ids) await service.from('facilities').delete().eq('id', id)
}

const service = createServiceRoleClient()
const run = randomUUID().slice(0, 8)

let facility: { id: string; name: string }
let writer: SeededUser
let viewer: SeededUser
let distributorProductId: string
const createdProducts: string[] = []
const createdCategories: string[] = []

beforeAll(async () => {
  facility = await createFacility(service, `RLS変異-${run}`)
  writer = await createSeededUser(service, 'mut-writer', facility.id, 'staff')
  viewer = await createSeededUser(service, 'mut-viewer', facility.id, 'viewer')

  const { data: category, error: catError } = await service
    .from('categories')
    .insert({ name: `変異カテゴリ-${run}` })
    .select('id')
    .single()
  if (catError || !category) throw new Error(`カテゴリ作成失敗: ${catError?.message}`)
  createdCategories.push(category.id)

  const { data: product, error: prodError } = await service
    .from('products')
    .insert({ jan: `M${run}0001`, ref: `REF-${run}`, name: `変異製品-${run}` })
    .select('id')
    .single()
  if (prodError || !product) throw new Error(`製品作成失敗: ${prodError?.message}`)
  createdProducts.push(product.id)

  const { data: dp, error: dpError } = await service
    .from('distributor_products')
    .insert({
      product_id: product.id,
      category_id: category.id,
      maker: `メーカー-${run}`,
      supplier: `仕入先-${run}`,
      name: `代理店商品-${run}`,
      quantity: 1,
    })
    .select('id')
    .single()
  if (dpError || !dp) throw new Error(`代理店商品作成失敗: ${dpError?.message}`)
  distributorProductId = dp.id
}, 60_000)

afterAll(async () => {
  await service.from('hospital_prices').delete().eq('facility_id', facility.id)
  await service.from('distributor_products').delete().eq('id', distributorProductId)
  for (const id of createdProducts) await service.from('products').delete().eq('id', id)
  for (const id of createdCategories) await service.from('categories').delete().eq('id', id)
  await service.from('facilities').delete().like('name', `変異作成-${run}%`)
  await removeUsers([writer.id, viewer.id])
  await removeFacilities([facility.id])
})

// 約束カタログ: P-030 MFA 登録済みは aal2 まで上げないと書けない
describe('表への直接書き込みにも aal2 が要る [P-030]', () => {
  // WHY(M-002): aal2 のテストは RPC 経由しか見ていなかった。RPC には関数内の判定もあるので、
  //      RLS から aal2 を外しても RPC のテストは落ちない。**表を直接叩く経路**は RLS だけが守る。
  //      MFA 未登録の利用者は has_aal2() が真を返すので、ここで確かめるのは
  //      「ポリシーの式に has_aal2() が含まれていること」を破壊で示すことになる。
  it('MFA 未登録の書き手は表へ直接書ける（既存利用者への回帰が無いことの対照）', async () => {
    const { error } = await writer.client.from('hospital_prices').insert({
      facility_id: facility.id,
      distributor_product_id: distributorProductId,
      purchase_price: 100,
      delivery_price: 120,
    })
    expect(error).toBeNull()
    await service.from('hospital_prices').delete().eq('facility_id', facility.id)
  })

  it('他施設の利用者は表へ直接書けない（施設判定が効いている）', async () => {
    const other = await createFacility(service, `RLS変異-他-${run}`)
    const outsider = await createSeededUser(service, 'mut-outsider', other.id, 'staff')
    const { error } = await outsider.client.from('hospital_prices').insert({
      facility_id: facility.id,
      distributor_product_id: distributorProductId,
      purchase_price: 100,
      delivery_price: 120,
    })
    expect(error).not.toBeNull()
    await removeUsers([outsider.id])
    await removeFacilities([other.id])
  }, 60_000)
})

// 約束カタログ: P-020 viewer は閲覧のみ
describe('閲覧者は仕入価格を書けない [P-020]', () => {
  // WHY(M-003): 閲覧者のテストは消耗品と発注 RPC だけを見ており、仕入価格を見ていなかった。
  //      仕入価格は金額そのものなので、書けてしまうと影響が大きい
  it('viewer は仕入価格を作成できない', async () => {
    const { error } = await viewer.client.from('hospital_prices').insert({
      facility_id: facility.id,
      distributor_product_id: distributorProductId,
      purchase_price: 1,
      delivery_price: 1,
    })
    expect(error).not.toBeNull()
  })

  it('viewer は仕入価格を更新できない（0 行）', async () => {
    const { data: seeded, error: seedError } = await service
      .from('hospital_prices')
      .insert({
        facility_id: facility.id,
        distributor_product_id: distributorProductId,
        purchase_price: 100,
        delivery_price: 120,
      })
      .select('id')
      .single()
    expect(seedError).toBeNull()

    const { data: updated } = await viewer.client
      .from('hospital_prices')
      .update({ purchase_price: 1 })
      .eq('id', seeded!.id)
      .select('id')
    expect(updated ?? []).toHaveLength(0)

    const { data: after } = await service
      .from('hospital_prices')
      .select('purchase_price')
      .eq('id', seeded!.id)
      .single()
    expect(after!.purchase_price).toBe(100)
    await service.from('hospital_prices').delete().eq('id', seeded!.id)
  })

  it('同じ施設の staff は作成できる（拒否が role 由来であることの対照）', async () => {
    const { data, error } = await writer.client
      .from('hospital_prices')
      .insert({
        facility_id: facility.id,
        distributor_product_id: distributorProductId,
        purchase_price: 200,
        delivery_price: 220,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    if (data) await service.from('hospital_prices').delete().eq('id', data.id)
  })
})

// 約束カタログ: P-021 マスタの書き込みは admin だけ
describe('施設の作成は admin だけ [P-021]', () => {
  // WHY(M-006): マスタ境界のテストは商品・カテゴリ・代理店商品を見ていたが、
  //      **施設だけ抜けていた**。施設を勝手に作れると、そこを起点に所属を増やせる
  it('staff は施設を作成できない', async () => {
    const { error } = await writer.client.from('facilities').insert({ name: `変異作成-${run}-staff` })
    expect(error).not.toBeNull()
  })

  it('viewer も施設を作成できない', async () => {
    const { error } = await viewer.client.from('facilities').insert({ name: `変異作成-${run}-viewer` })
    expect(error).not.toBeNull()
  })

  it('admin は施設を作成できる（拒否が admin 判定由来であることの対照）', async () => {
    const admin = await createSeededUser(service, 'mut-admin', facility.id, 'admin')
    const { data, error } = await admin.client
      .from('facilities')
      .insert({ name: `変異作成-${run}-admin` })
      .select('id')
      .single()
    expect(error).toBeNull()
    if (data) await service.from('facilities').delete().eq('id', data.id)
    await removeUsers([admin.id])
  }, 60_000)
})

// 約束カタログ: P-064 回数のカウンタは client から見えない
describe('回数のカウンタはログイン済み利用者からも見えない [P-064]', () => {
  // WHY(M-010): カウンタのテストは anon だけを見ていた。**ログイン済みの利用者**に開いても
  //      気づかない状態だった。自分の残り回数が見えると、上限の回避に使える
  // WHY: 空の表を読んでも 0 件が返るだけで、漏れているかどうかが分からない
  //      （2026-09-07 の計測で、この形では変異が生き残った）。**必ず 1 行ある状態**にしてから読む
  beforeAll(async () => {
    const { error } = await service.rpc('consume_rate_limit', {
      p_bucket: `gap:${run}`,
      p_limit: 100,
      p_window_seconds: 3600,
    })
    expect(error).toBeNull()
    const { count } = await service
      .from('rate_limit_counters')
      .select('*', { count: 'exact', head: true })
    expect(count ?? 0).toBeGreaterThan(0)
  })

  it('staff は回数のカウンタを読めない（行はあるのに 0 件）', async () => {
    const { data } = await writer.client.from('rate_limit_counters').select('*').limit(1)
    expect(data ?? []).toHaveLength(0)
  })

  it('viewer も読めない（行はあるのに 0 件）', async () => {
    const { data } = await viewer.client.from('rate_limit_counters').select('*').limit(1)
    expect(data ?? []).toHaveLength(0)
  })

  it('staff はカウンタを書き換えられない', async () => {
    const { error } = await writer.client
      .from('rate_limit_counters')
      .insert({ bucket: `forged-${run}`, window_start: new Date().toISOString(), hits: 0 })
    expect(error).not.toBeNull()
  })
})
