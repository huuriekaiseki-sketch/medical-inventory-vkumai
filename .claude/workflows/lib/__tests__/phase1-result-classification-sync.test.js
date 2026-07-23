import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase1.js')
const LIB_FILE = path.resolve(__dirname, '../phase1-result-classification.js')

// aidd-phase1.js（Workflow DSL、require不可）内にインライン複製されたSweep結果分類ロジックが、
// lib/phase1-result-classification.js の正本と一字一句ドリフトしていないかを検証する
// （issue #521。router-risk-sync.test.js / workflow-prompt-sync.test.js と同型のガード）。
const DECLARATIONS = ['describeSweepResult', 'classifyPhase1Results']

describe('aidd-phase1.jsのSweep結果分類ロジック同期(issue #521)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  for (const name of DECLARATIONS) {
    it(`${name} がaidd-phase1.jsとlib/phase1-result-classification.jsで一致する`, () => {
      const workflowDecl = extractDeclaration(workflowSource, name)
      const libDecl = extractDeclaration(libSource, name)
      expect(workflowDecl).toBe(libDecl)
    })
  }
})
