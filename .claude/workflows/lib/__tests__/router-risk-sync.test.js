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
// issue #456で追加された簡易版sync test（CORE_LOGIC文字列の部分一致チェック）は、classifyRisk
// を宣言単位で丸ごと比較するこちらのテストに統合した（classifyRiskをDECLARATIONSに含めており、
// 部分一致よりも厳密にドリフトを検知できるため）。
// issue #420 v1 セット B: 固有語彙（旧 RISK_KEYWORDS 等）は aidd.config.json と router 側の
// LOCAL_RISK_CONFIG へ移り、ここで同期するのはエンジン（汎用既定値と判定関数）のみ。
// LOCAL_RISK_CONFIG と aidd.config.json の同期は aidd-config.test.js が検証する。
const DECLARATIONS = [
  'DEFAULT_RISK_CONFIG',
  'resolveRiskConfig',
  'isHighRiskPath',
  'matchTaskKeywords',
  'isMetaPipelinePath',
  'isMetaPipelineOnlyChange',
  'classifyRisk',
  'classifyRoute',
]

describe('aidd-phase1-router.jsのTRI/RISK・メタ改修判定ロジック同期(issue #456, #457)', () => {
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
