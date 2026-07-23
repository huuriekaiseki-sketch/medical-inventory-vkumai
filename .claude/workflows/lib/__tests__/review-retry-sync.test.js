import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const LIB_FILE = path.resolve(__dirname, '../review-retry.js')

// aidd-phase2.js（Workflow DSL、require不可）内にインライン複製されたReview判定ロジックが、
// lib/review-retry.js の正本と一字一句ドリフトしていないかを検証する
// （issue #525のPRレビューで発覚: classifyReviewRoundにはこれまでsync testが無く、
// nullをblockedにもfailedにも分類しない抜け道が長期間見過ごされていた。
// router-risk-sync.test.js / phase1-result-classification-sync.test.js と同型のガード）。
const DECLARATIONS = ['classifyReviewRound', 'describeReviewResult']

describe('aidd-phase2.jsのReview判定ロジック同期(issue #525)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  for (const name of DECLARATIONS) {
    it(`${name} がaidd-phase2.jsとlib/review-retry.jsで一致する`, () => {
      const workflowDecl = extractDeclaration(workflowSource, name)
      const libDecl = extractDeclaration(libSource, name)
      expect(workflowDecl).toBe(libDecl)
    })
  }
})
