import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../phase2-done.js')

// aidd-phase2.js（Workflow DSL、require不可）にインライン複製されたDONE判定が、
// lib/phase2-done.js の正本とドリフトしていないかを検証する。
//
// なぜ今これを足すか（issue R01）: DONE判定はこれまでインライン側が
// `const done = allPass(...) && ...` という式で書かれており、名前の付いた宣言が無いため
// sync testを掛けられなかった。「同一ロジック」と書いたコメントだけが同期の根拠で、
// 片方だけ直しても誰も気づかない。証拠の鮮度(evidence)を足すのに合わせて
// インライン側も computeDone という関数に揃え、機械で突き合わせられるようにした。
const DECLARATIONS = ['allPass', 'lastRetryAccepted', 'computeDone']

describe('aidd-phase2.jsのDONE判定同期(issue #46/R01)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  for (const name of DECLARATIONS) {
    it(`${name} がaidd-phase2.jsとlib/phase2-done.jsで一致する`, () => {
      const workflowDecl = extractDeclaration(workflowSource, name)
      const libDecl = extractDeclaration(libSource, name)
      expect(workflowDecl).toBe(libDecl)
    })
  }

  it('aidd-phase2.jsが証拠の鮮度(integrationFresh)をcomputeDoneへ渡している', () => {
    // 宣言の一致だけでは「呼び出し側が第5引数を渡し忘れた」ケースを捕まえられない。
    // 渡し忘れるとevidenceがundefinedになりDONEは常にfalse（安全側）だが、
    // フローが永久に完了しなくなるので、配線そのものも見る。
    expect(workflowSource).toMatch(
      /computeDone\(\s*implResults,\s*integrationResult,\s*reviewResults,\s*manifestCheck,\s*\{\s*integrationFresh,\s*lastRetryResult,?\s*\}\s*\)/,
    )
  })

  it('差し戻し修正の直後に統合ゲートの鮮度が落とされている', () => {
    // 「修正したら古い証拠を捨てる」という肝の1行が消えても、単体テストは
    // computeDoneの中しか見ないので緑のまま通ってしまう。
    expect(workflowSource).toContain('integrationFresh = false')
    expect(workflowSource).toContain('integration-recheck:R')
  })
})
