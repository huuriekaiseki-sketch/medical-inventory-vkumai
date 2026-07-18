import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROUTER_FILE = path.resolve(__dirname, '../../aidd-phase1-router.js')
const LIB_FILE = path.resolve(__dirname, '../router-risk.js')

// aidd-phase1-router.js（Workflow DSL、require不可）内にインライン複製されたTRI/RISK・
// メタ改修判定ロジックが、lib/router-risk.js の正本と一字一句ドリフトしていないかを検証する
// （issue #457。workflow-prompt-sync.test.js / sweep-prompt-sync.test.js と同型のガード）。
const DECLARATIONS = [
  'RISK_KEYWORDS',
  'RISK_PATH_PREFIXES',
  'RISK_DOMAIN_KEYWORDS',
  'isHighRiskPath',
  'matchTaskKeywords',
  'META_PATH_PREFIXES',
  'isMetaPipelinePath',
  'isMetaPipelineOnlyChange',
  'classifyRisk',
  'classifyRoute',
]

describe('aidd-phase1-router.jsのTRI/RISK・メタ改修判定ロジック同期(issue #457)', () => {
  const routerSource = readFileSync(ROUTER_FILE, 'utf-8')
  const libSource = readFileSync(LIB_FILE, 'utf-8')

  for (const name of DECLARATIONS) {
    it(`${name} がaidd-phase1-router.jsとlib/router-risk.jsで一致する`, () => {
      const routerDecl = extractDeclaration(routerSource, name)
      const libDecl = extractDeclaration(libSource, name)
      expect(routerDecl).toBe(libDecl)
    })
  }
})
