import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const SEVERITY_FILE = path.resolve(__dirname, '../severity.js')
const QUALITY_GATE_FILE = path.resolve(__dirname, '../quality-gate.js')

// aidd-phase2.js（Workflow DSL、require不可）内にインライン複製された品質ゲート判定ロジックが、
// lib/severity.js・lib/quality-gate.js の正本と一字一句ドリフトしていないかを検証する
// （issue #549。router-risk-sync.test.js / phase1-result-classification-sync.test.js と同型のガード）。
//
// 背景: これら2関数はaidd-phase2.js内の5箇所すべてのdeny-by-defaultゲート
// （Spec Check・Manifest Check・Contract+DB・Implement・Coverage Check・Integrate・Review）が
// 依存する中核ロジックだが、2026-07-26のOpus設計評価まで同期テストが存在しなかった
// （router-risk等と同じ「正本・テストはlib側」という体裁でありながら、実際には同期を
// 検証する仕組みが無いという不一致があった）。
describe('aidd-phase2.jsの品質ゲート判定ロジック同期(issue #549)', () => {
  const workflowSource = readFileSync(WORKFLOW_FILE, 'utf-8')
  const severitySource = readFileSync(SEVERITY_FILE, 'utf-8')
  const qualityGateSource = readFileSync(QUALITY_GATE_FILE, 'utf-8')

  it('isMinorOnlyFailure がaidd-phase2.jsとlib/severity.jsで一致する', () => {
    const workflowDecl = extractDeclaration(workflowSource, 'isMinorOnlyFailure')
    const libDecl = extractDeclaration(severitySource, 'isMinorOnlyFailure')
    expect(workflowDecl).toBe(libDecl)
  })

  it('shouldBlock がaidd-phase2.jsとlib/quality-gate.jsで一致する', () => {
    const workflowDecl = extractDeclaration(workflowSource, 'shouldBlock')
    const libDecl = extractDeclaration(qualityGateSource, 'shouldBlock')
    expect(workflowDecl).toBe(libDecl)
  })
})
