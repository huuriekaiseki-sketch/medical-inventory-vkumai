// WHY: issue #757 の 20。層の突合（check-layer-consistency.test.sh）の最初の版は
//      schemas.ts を**文字列として**読み、「共通ヘルパーを使っているか」だけを見ていた。
//      これには 2 つの弱さがあった。
//        (1) 書き方を変えれば外れる（正規表現の照合なので）
//        (2) **値そのものを比べられない**（DB 500 対 API 1,000 の食い違いを見つけられない）
//      zod のスキーマは実行時に内省できる（`_zod.bag` に minimum / maximum、
//      enum は `def.entries`）ので、**実物から値を取り出して**突き合わせる。
//
//      2026-09-07 の実測: `_zod.bag` は文字列なら { minimum: 最小長, maximum: 最大長 }、
//      数値なら { minimum: 下限 } を返す。optional / nullable / pipe / default は剥がす。
//
// 使い方: npx tsx scripts/lib/extract-api-rules.ts
//   出力は JSON（{ "<スキーマ名>.<フィールド名>": { type, maxLength, min, enum } }）。

import * as schemas from '../../src/lib/validation/schemas'

type Any = Record<string, unknown>

/** optional / nullable / pipe / default を剥がして中身の型に降りる */
function peel(node: Any, depth = 0): Any {
  if (depth > 8) return node
  const z = (node?._zod ?? {}) as Any
  const def = (z.def ?? {}) as Any
  if (def.type === 'pipe') return peel(def.in as Any, depth + 1)
  if (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') {
    return peel(def.innerType as Any, depth + 1)
  }
  return node
}

export interface ApiRule {
  type: string | null
  maxLength: number | null
  min: number | null
  enum: string[] | null
}

function ruleOf(node: Any): ApiRule {
  const inner = peel(node)
  const z = (inner?._zod ?? {}) as Any
  const def = (z.def ?? {}) as Any
  const bag = (z.bag ?? {}) as Any
  const type = (def.type as string) ?? null
  return {
    type,
    // 文字列の maximum は「最大長」、数値の minimum は「下限」
    maxLength: type === 'string' && typeof bag.maximum === 'number' ? bag.maximum : null,
    min: type === 'number' && typeof bag.minimum === 'number' ? bag.minimum : null,
    enum: def.entries ? Object.keys(def.entries as Any) : null,
  }
}

/** z.object の shape を辿る。配列の要素が object ならその中も拾う */
function collect(name: string, node: Any, out: Record<string, ApiRule>, depth = 0) {
  if (depth > 4) return
  const inner = peel(node)
  const z = (inner?._zod ?? {}) as Any
  const def = (z.def ?? {}) as Any

  if (def.type === 'object') {
    const shape = (inner as { shape?: Record<string, Any> }).shape ?? {}
    for (const [field, child] of Object.entries(shape)) {
      const key = `${name}.${field}`
      out[key] = ruleOf(child)
      // 明細の配列など、入れ子の object も同じ名前空間で拾う（フィールド名は一意に保つ）
      collect(name, child, out, depth + 1)
    }
    return
  }
  if (def.type === 'array') {
    collect(name, def.element as Any, out, depth + 1)
  }
}

const out: Record<string, ApiRule> = {}
for (const [name, schema] of Object.entries(schemas as Record<string, unknown>)) {
  if (!name.endsWith('Schema')) continue
  collect(name, schema as Any, out)
}

const sorted: Record<string, ApiRule> = {}
for (const key of Object.keys(out).sort()) sorted[key] = out[key]
console.log(JSON.stringify(sorted, null, 2))
