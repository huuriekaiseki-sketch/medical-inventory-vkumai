// supabase/__tests__/integration/remaining-text-length-limits.integration.test.ts
// WHY: issue #757 の 20。20260907000004 で 10 列に上限を足したが、**3 列を足し損ねていた**。
//      人が数え直したのではなく、scripts/lib/scan-text-columns.mjs（migration を適用順に
//      畳み込んで「上限も固定語も無い TEXT 列」を列挙する）が機械で見つけた。
//      ここでは 20260907000007 で足した 3 列が実 DB で本当に効くことを固定する。
//
//      同じ見落としが次に起きたら scripts/check-text-column-limits.test.sh が止める。

import { randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createServiceRoleClient } from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'
const service = createServiceRoleClient()
const run = randomUUID().slice(0, 8)
const long = (n: number) => 'あ'.repeat(n)

const createdCategories: string[] = []

afterAll(async () => {
  for (const id of createdCategories) await service.from('categories').delete().eq('id', id)
})

// 不変条件カタログ: I-067（取りこぼしていた自由入力の長さ）
describe('取りこぼしていた自由入力の列に上限がある [I-067]', () => {
  it('カテゴリの説明は 1,000 文字を超えると拒否される', async () => {
    const { error } = await service
      .from('categories')
      .insert({ name: `説明長さ-${run}`, description: long(1001) })
    expect(error?.code).toBe(CHECK_VIOLATION)
  })

  it('カテゴリの説明はちょうど 1,000 文字なら通る（境界）', async () => {
    const { data, error } = await service
      .from('categories')
      .insert({ name: `説明境界-${run}`, description: long(1000) })
      .select('id')
      .single()
    expect(error).toBeNull()
    if (data) createdCategories.push(data.id)
  })

  it('説明が空でも通る（弾くのは「長すぎる」であって「空」ではない）', async () => {
    const { data, error } = await service
      .from('categories')
      .insert({ name: `説明なし-${run}`, description: null })
      .select('id')
      .single()
    expect(error).toBeNull()
    if (data) createdCategories.push(data.id)
  })

  it('拒否の記録の経路は 200 文字を超えると拒否される', async () => {
    const { error } = await service.from('access_denials').insert({
      guard: 'facility',
      reason: 'forbidden',
      route: '/'.padEnd(201, 'a'),
    })
    // WHY: client は INSERT できないので service_role で直接入れて CHECK だけを見る。
    //      権限そのものは access-denials-rls-idor が守る
    expect(error).not.toBeNull()
  })
})

// WHY(2026-09-08 に見つけた穴): 20260907060000 で `products.name` / `products.maker` に
//      上限を足したが、**それを守るテストが 1 本も無かった**。
//      `scripts/check-constraint-coverage.sh` は「その migration が触る表の名前が統合テストの
//      どこかに出ているか」で数えるので、`products` を使うテストが既にある以上
//      「カバー済み」に見えてしまう（**制約単位では見ていない**）。
//      検査が緑でも守られていない、の実例なのでここに実測を置く。
describe('製品マスタの自由入力に上限がある [I-067]', () => {
  const createdProducts: string[] = []
  afterAll(async () => {
    for (const jan of createdProducts) await service.from('products').delete().eq('jan', jan)
  })

  const jan = (n: number) => `49${String(n).padStart(11, '0')}`

  it('製品名は 200 文字を超えると拒否される', async () => {
    const { error } = await service
      .from('products')
      .insert({ jan: jan(1), ref: `ref-name-over-${run}`, name: long(201) })
    expect(error?.code).toBe(CHECK_VIOLATION)
  })

  it('製品名はちょうど 200 文字なら通る（境界の反対側）', async () => {
    const j = jan(2)
    const { error } = await service
      .from('products')
      .insert({ jan: j, ref: `ref-name-edge-${run}`, name: long(200) })
    expect(error).toBeNull()
    if (!error) createdProducts.push(j)
  })

  it('メーカー名は 200 文字を超えると拒否される', async () => {
    const { error } = await service
      .from('products')
      .insert({ jan: jan(3), ref: `ref-maker-over-${run}`, name: `メーカー超過-${run}`, maker: long(201) })
    expect(error?.code).toBe(CHECK_VIOLATION)
  })

  it('メーカー名はちょうど 200 文字なら通る（境界の反対側）', async () => {
    const j = jan(4)
    const { error } = await service
      .from('products')
      .insert({ jan: j, ref: `ref-maker-edge-${run}`, name: `メーカー境界-${run}`, maker: long(200) })
    expect(error).toBeNull()
    if (!error) createdProducts.push(j)
  })

  it('メーカー名が空でも通る（弾くのは「長すぎる」であって「空」ではない）', async () => {
    const j = jan(5)
    const { error } = await service
      .from('products')
      .insert({ jan: j, ref: `ref-maker-null-${run}`, name: `メーカー無し-${run}`, maker: null })
    expect(error).toBeNull()
    if (!error) createdProducts.push(j)
  })
})
