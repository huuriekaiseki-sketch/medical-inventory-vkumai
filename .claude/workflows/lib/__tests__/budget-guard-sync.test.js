import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LIB_FILE = path.resolve(__dirname, '../budget-guard.js')
const WORKFLOW_FILES = [
  path.resolve(__dirname, '../../aidd-1-1-deep-task.js'),
  path.resolve(__dirname, '../../aidd-phase2.js'),
]

// aidd-1-1-deep-task.js / aidd-phase2.js（Workflow DSL、require不可）内にインライン複製された
// サーキットブレーカー判定（isDefaultCapExceeded）が、lib/budget-guard.js の正本と
// 一字一句ドリフトしていないかを検証する（router-risk-sync.test.js と同型のガード）。
// DEFAULT_TOKEN_CAPの値はworkflowごとに意図的に異なる（deep-task: 2M / phase2: 2.5M）ため
// 同期対象にしない。既存のisBudgetExhaustedはdeep-task側がbudgetをクロージャで参照する
// 適応版のため宣言単位の同期対象外（budget-guard.js冒頭コメント参照）。
//
// 注意: extractDeclarationは宣言後の最初の `{` を本体開始とみなすため、同期対象の関数は
// パラメータに分割代入 `({ ... })` を使ってはならない（引数部分だけが抽出され、本体の
// ドリフトを検知できない偽陰性になる。本テスト導入時のfault injectionで実測済み）。
describe('isDefaultCapExceededのインライン複製同期', () => {
  const libDecl = extractDeclaration(readFileSync(LIB_FILE, 'utf-8'), 'isDefaultCapExceeded')

  for (const file of WORKFLOW_FILES) {
    it(`${path.basename(file)} のisDefaultCapExceededがlib/budget-guard.jsと一致する`, () => {
      const workflowDecl = extractDeclaration(readFileSync(file, 'utf-8'), 'isDefaultCapExceeded')
      expect(workflowDecl).toBe(libDecl)
    })
  }
})
