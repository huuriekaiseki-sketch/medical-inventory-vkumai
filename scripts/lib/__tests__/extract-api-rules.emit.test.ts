import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractApiRules } from '../extract-api-rules'

// WHY: issue #757 の 20。層の突合（scripts/check-layer-consistency.test.sh）が使う
//      「API 側の実際の値」を書き出す。**TypeScript を実行する必要がある**ので、
//      node_modules に既にある vitest を実行系として借りる。
//
// WHY(npx -y tsx を使わない): 毎回レジストリから落としてくる。2026-09-04 に CI が 4〜8 倍
//      かかった原因で、scripts/check-no-registry-fetch.test.sh が hook スクリプトで禁止している。
//      同じ理由をここにも当てはめる。
//
// あわせて、抽出そのものが壊れていないことも確かめる（0 件を返して突合が素通りするのを防ぐ）。

describe('API 側の規則を書き出す', () => {
  it('主要なスキーマから値が取れ、ファイルに書き出せる', () => {
    const rules = extractApiRules()
    const keys = Object.keys(rules)

    // fail-open 防止: 抽出が壊れたら 0 件になり、突合が全部素通りしてしまう
    expect(keys.length).toBeGreaterThan(20)

    // 実際の値まで取れていること（種類だけでなく数値・語の一覧）
    expect(rules['consumableInputSchema.name']?.maxLength).toBeGreaterThan(0)
    expect(rules['hospitalPriceInputSchema.purchasePrice']?.min).not.toBeNull()
    expect(rules['caseOrderInputSchema.gender']?.enum).toEqual(['male', 'female', 'other'])

    const out = path.resolve(__dirname, '../../../.api-rules.json')
    fs.writeFileSync(out, JSON.stringify(rules, null, 2) + '\n')
    expect(fs.existsSync(out)).toBe(true)
  })
})
