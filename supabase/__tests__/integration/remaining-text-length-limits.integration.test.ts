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
