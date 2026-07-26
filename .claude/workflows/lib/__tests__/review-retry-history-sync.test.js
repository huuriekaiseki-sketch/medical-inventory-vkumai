import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../review-retry-history.js')

// aidd-phase2.js（Workflow DSL、require不可）内にインライン複製されたReviewリトライ履歴の
// 組み立てロジックが、lib/review-retry-history.js の正本と一字一句ドリフトしていないかを
// 検証する（issue #549。router-risk-sync.test.js と同型のガード）。
//
// MAX_RETRY_HISTORY_ENTRIES（スカラー定数）はextractDeclarationの対象外
// （関数・配列宣言のみ対応。extract-declaration.jsのコメント参照）のため、
// buildRetryHistorySection関数本体のみを比較する。
describe('aidd-phase2.jsのReviewリトライ履歴組み立てロジック同期(issue #549)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  it('buildRetryHistorySection がaidd-phase2.jsとlib/review-retry-history.jsで一致する', () => {
    const workflowDecl = extractDeclaration(workflowSource, 'buildRetryHistorySection')
    const libDecl = extractDeclaration(libSource, 'buildRetryHistorySection')
    expect(workflowDecl).toBe(libDecl)
  })
})
