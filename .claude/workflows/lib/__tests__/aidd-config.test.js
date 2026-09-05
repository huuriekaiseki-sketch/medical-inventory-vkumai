import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extractDeclaration } from '../extract-declaration.js'
import { DEFAULT_RISK_CONFIG, resolveRiskConfig, classifyRoute } from '../router-risk.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CONFIG_FILE = path.join(REPO_ROOT, 'aidd.config.json')
const SCHEMA_FILE = path.join(REPO_ROOT, 'scripts/lib/aidd-config.schema.json')
const ROUTER_FILE = path.resolve(__dirname, '../../aidd-phase1-router.js')
const LIB_FILE = path.resolve(__dirname, '../router-risk.js')

// WHY: issue #420 v1 セット B。判定エンジン（router-risk.js）から vkumai 固有の語彙を
// aidd.config.json（導入先アダプター）へ移した。壊れ方は 3 つ考えられる:
//   1. aidd.config.json と aidd-phase1-router.js の LOCAL_RISK_CONFIG（Workflow DSL は
//      ファイルを読めないためのインライン複製）がずれる → derive と router で判定が食い違う
//   2. 共通側の既定値に vkumai / Supabase 固有の語が紛れ込む → プラグイン化で「vkumai 専用
//      設定をそのまま汎用にしない」が破れる
//   3. 設定が空・欠損のとき判定が緩む → 迷ったら高リスク側の原則が破れる
// この 3 つを固定する。スキーマ検証は依存を増やさず（ajv 不採用）、必要な型・重複の検査だけ行う。

const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf-8'))

// LOCAL_RISK_CONFIG の宣言テキストから、キーごとの文字列配列を評価せずに取り出す
// （ソースを実行しない。tri-risk-docs-sync.test.js の stringLiterals と同じ方針）
function parseLocalRiskConfig() {
  const decl = extractDeclaration(readFileSync(ROUTER_FILE, 'utf-8'), 'LOCAL_RISK_CONFIG')
  const result = {}
  for (const m of decl.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    result[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])
  }
  return result
}

describe('aidd.config.json（導入先アダプター、issue #420 v1 セット B）', () => {
  it('スキーマに無いトップレベルキーを持たない（additionalProperties: false）', () => {
    const allowed = Object.keys(schema.properties)
    for (const key of Object.keys(config)) expect(allowed).toContain(key)
  })

  it('risk の各配列は空文字なし・重複なしの文字列配列', () => {
    for (const key of ['keywords', 'pathPrefixes', 'domainKeywords']) {
      const arr = config.risk[key]
      expect(Array.isArray(arr)).toBe(true)
      for (const v of arr) {
        expect(typeof v).toBe('string')
        expect(v.length).toBeGreaterThan(0)
      }
      expect(new Set(arr).size).toBe(arr.length)
    }
  })

  it('aidd-phase1-router.js の LOCAL_RISK_CONFIG と aidd.config.json の risk が一致する（インライン複製の同期）', () => {
    const local = parseLocalRiskConfig()
    expect(local).toEqual(config.risk)
  })

  it('LOCAL_RISK_CONFIG は @aidd-local-config マーカーで囲まれている（プラグイン生成時の差し替え点）', () => {
    const src = readFileSync(ROUTER_FILE, 'utf-8')
    const begin = src.indexOf('// @aidd-local-config:begin')
    const end = src.indexOf('// @aidd-local-config:end')
    const decl = src.indexOf('const LOCAL_RISK_CONFIG')
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(decl)
    expect(decl).toBeGreaterThan(begin)
  })
})

describe('DEFAULT_RISK_CONFIG（共通側の汎用既定値）', () => {
  const FORBIDDEN = ['vkumai', 'medical', 'facility', 'tenant', 'organization', 'inventory', 'supabase', 'npm', 'next']

  it('vkumai / スタック固有の語を含まない（プラグイン化の禁止語）', () => {
    const text = JSON.stringify(DEFAULT_RISK_CONFIG).toLowerCase()
    for (const word of FORBIDDEN) expect(text).not.toContain(word)
  })

  it('router-risk.js のソース全体にも禁止語が無い（コメント込み。共通プラグインへそのままコピーするため）', () => {
    // 'facility' は issue 経緯の説明として残す価値があるため、コメント中の 1 回だけ許容する
    const src = readFileSync(LIB_FILE, 'utf-8').toLowerCase()
    for (const word of ['vkumai', 'medical', 'supabase', 'npm ']) expect(src).not.toContain(word)
  })

  it('既定値だけでも auth / rls / policy / migration を含むパスは高リスク（設定が空でも緩まない）', () => {
    for (const p of ['src/auth/login.ts', 'db/migrations/001.sql', 'lib/rls.ts', 'policy/x.ts']) {
      expect(classifyRoute('', [p]).route).toBe('deep')
      expect(classifyRoute('', [p], {}).route).toBe('deep')
      expect(classifyRoute('', [p], { keywords: [], pathPrefixes: [], domainKeywords: [] }).route).toBe('deep')
    }
  })

  it('既定値だけでは facility パスは高リスクにならず、vkumai の設定を足すと高リスクになる', () => {
    const p = 'src/app/facility/page.tsx'
    expect(classifyRoute('', [p]).route).toBe('light')
    expect(classifyRoute('', [p], config.risk).route).toBe('deep')
  })
})

describe('resolveRiskConfig', () => {
  it('既定値に足すだけで、既定値の語は消せない', () => {
    const r = resolveRiskConfig({ domainKeywords: ['facility'], keywords: [], pathPrefixes: [] })
    for (const kw of DEFAULT_RISK_CONFIG.domainKeywords) expect(r.domainKeywords).toContain(kw)
    expect(r.domainKeywords).toContain('facility')
  })

  it('重複・空文字・非文字列は捨てる', () => {
    const r = resolveRiskConfig({ domainKeywords: ['auth', '', 42, 'auth', 'x'] })
    expect(r.domainKeywords.filter(k => k === 'auth').length).toBe(1)
    expect(r.domainKeywords).not.toContain('')
    expect(r.domainKeywords).toContain('x')
  })

  it('undefined / null / 配列でない値でも壊れず既定値になる', () => {
    expect(resolveRiskConfig(undefined)).toEqual(resolveRiskConfig({}))
    expect(resolveRiskConfig(null)).toEqual(resolveRiskConfig({}))
    expect(resolveRiskConfig({ keywords: 'auth' }).keywords).toEqual(DEFAULT_RISK_CONFIG.keywords)
  })

  it('base を渡すと二段階で足せる（router の 汎用 ← LOCAL ← args の順）', () => {
    const local = resolveRiskConfig({ domainKeywords: ['facility'] })
    const withArgs = resolveRiskConfig({ domainKeywords: ['corpus'] }, local)
    expect(withArgs.domainKeywords).toContain('facility')
    expect(withArgs.domainKeywords).toContain('corpus')
    expect(withArgs.domainKeywords).toContain('auth')
  })
})
