import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-1-1-deep-task.js')
const LIB_FILE = path.resolve(__dirname, '../find-av-precision.js')

// aidd-1-1-deep-task.js（Workflow DSL、require不可）内にインライン複製されたFind-AV
// precision集計ロジックが、lib/find-av-precision.js の正本と一字一句ドリフトしていないかを
// 検証する（issue #549。router-risk-sync.test.js と同型のガード）。
describe('aidd-1-1-deep-task.jsのFind-AV precision集計ロジック同期(issue #549)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  it('computeFindAvPrecision がaidd-1-1-deep-task.jsとlib/find-av-precision.jsで一致する', () => {
    const workflowDecl = extractDeclaration(workflowSource, 'computeFindAvPrecision')
    const libDecl = extractDeclaration(libSource, 'computeFindAvPrecision')
    expect(workflowDecl).toBe(libDecl)
  })
})
