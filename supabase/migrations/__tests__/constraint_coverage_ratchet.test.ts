import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  assessRisk,
  findAdminOnlyTablesWithoutTest,
  findRlsTablesWithoutIdorTest,
  findUndeclaredCardinality,
  findUncoveredConstraintMigrations,
} from '../../../.claude/workflows/lib/constraint-coverage.js'

// WHY: issue #675（短貸返却の二重登録）は、2026-07-14 に loan_returns へ loan_order_id を
//      後付けした時点で「1対1か1対多か」が宣言されず、migrationのテストが「実装で書いたSQLを
//      同じ文字列で照合する」静的検証だけだったため、84コミット・CI 173本を通過し続けても
//      検出されなかった。
//
//      再発防止としてratchet（歯止め）方式を採る: 既知の未対応分は
//      constraint-coverage-baseline.json に固定し、**新規発生のみ**をテストで止める。
//      既存の技術的負債の返済を強制せず、同じ穴が増えることだけを防ぐ。
//
//      既存分を解消したらbaselineから該当行を削除すること。削除し忘れ（もう存在しないのに
//      baselineに残っている）も下の「baselineに不要な行が残っていない」で検知する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const INTEGRATION_DIR = path.resolve(__dirname, '../../__tests__/integration')
const BASELINE_PATH = path.join(__dirname, 'constraint-coverage-baseline.json')

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as {
  undeclaredCardinality: string[]
  uncoveredIntegration: { migration: string; risk: 'high' | 'medium' | 'low' }[]
  rlsWithoutIdorTest: { table: string; risk: 'high' | 'medium' | 'low' }[]
  rlsIdorNotRequired: { table: string; reason: string }[]
}
const baselineMigrations = baseline.uncoveredIntegration.map((e) => e.migration)
const baselineRlsTables = baseline.rlsWithoutIdorTest.map((e) => e.table)

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8') }))

const integrationSource = existsSync(INTEGRATION_DIR)
  ? readdirSync(INTEGRATION_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(path.join(INTEGRATION_DIR, f), 'utf-8'))
      .join('\n')
  : ''

const cardinalityKeys: string[] = findUndeclaredCardinality({ migrations }).undeclared.map(
  (u: { name: string; table: string; column: string }) => `${u.name}:${u.table}.${u.column}`,
)
const appSource = collectSource([
  path.resolve(__dirname, '../../../src/lib'),
  path.resolve(__dirname, '../../../src/app'),
  path.resolve(__dirname, '../../../src/components'),
])
const allMigrationSql = migrations.map((m) => m.sql).join('\n')

const uncovered: {
  name: string
  tables: string[]
  constraintCount: number
}[] = findUncoveredConstraintMigrations({ migrations, integrationSource }).uncovered
const coverageKeys = uncovered.map((u) => u.name)
const actualRisk = new Map(
  uncovered.map((u) => [
    u.name,
    assessRisk({
      tables: u.tables,
      constraintCount: u.constraintCount,
      appSource,
      allMigrationSql,
    }).level,
  ]),
)

const idorTestSource = existsSync(INTEGRATION_DIR)
  ? readdirSync(INTEGRATION_DIR)
      .filter((f) => f.includes('idor'))
      .map((f) => readFileSync(path.join(INTEGRATION_DIR, f), 'utf-8'))
      .join('\n')
  : ''
const rlsUncovered: string[] = findRlsTablesWithoutIdorTest({
  allMigrationSql,
  idorTestSource,
  notRequired: baseline.rlsIdorNotRequired.map((e) => e.table),
}).uncovered
const actualRlsRisk = new Map(
  rlsUncovered.map((t) => [
    t,
    assessRisk({ tables: [t], constraintCount: 0, appSource, allMigrationSql }).level,
  ]),
)

const adminTestSource = existsSync(INTEGRATION_DIR)
  ? readdirSync(INTEGRATION_DIR)
      .filter((f) => f.includes('admin'))
      .map((f) => readFileSync(path.join(INTEGRATION_DIR, f), 'utf-8'))
      .join('\n')
  : ''
const adminUncovered: string[] = findAdminOnlyTablesWithoutTest({
  allMigrationSql,
  adminTestSource,
}).uncovered

/** 業務データ判定の材料としてアプリ本体のソースを集める（生成物の型定義は含めない） */
function collectSource(dirs: string[]): string {
  const chunks: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) chunks.push(readFileSync(full, 'utf-8'))
    }
  }
  dirs.forEach(walk)
  return chunks.join('\n').toLowerCase()
}

describe('DB制約カバレッジのratchet（issue #675 再発防止）', () => {
  it('カーディナリティ未宣言の後付けFK列が新規に増えていない', () => {
    // 増えていた場合の直し方:
    //   1対1なら UNIQUE 制約/インデックスを同じPRで追加する
    //   1対多なら migration の SQL に `-- cardinality: many <理由>` を書く
    const added = cardinalityKeys.filter((k) => !baseline.undeclaredCardinality.includes(k))
    expect(added).toEqual([])
  })

  it('実DB統合テストの対応が無い制約migrationが新規に増えていない', () => {
    // 増えていた場合の直し方:
    //   supabase/__tests__/integration/ に「制約を破る操作が拒否される」テストを追加する
    //   統合テストが不要と判断したなら `-- integration-coverage: not-required <理由>` を書く
    const added = coverageKeys.filter((k) => !baselineMigrations.includes(k))
    expect(added).toEqual([])
  })

  it('RLSポリシーを持つのにIDORテストが無いテーブルが新規に増えていない', () => {
    // 増えていた場合の直し方:
    //   supabase/__tests__/integration/*-rls-idor.integration.test.ts に
    //   「他人（別施設のユーザー）で叩くと弾かれる」テストを追加する
    //   （known-failure-patterns.md「動いたからOKで…見逃す（issue #24再発防止）」参照）
    const added = rlsUncovered.filter((t) => !baselineRlsTables.includes(t))
    expect(added).toEqual([])
  })

  it('adminだけが書けるのに非adminで試していないテーブルが無い', () => {
    // WHY: RLS/IDOR軸で「施設境界の約束が無い」として除外したマスタ群は、
    //      代わりに admin境界を守っている。そちらの軸を持たないと
    //      「面倒な指摘を除外リストに逃がしただけ」になる。
    //      直し方: *-admin-boundary.integration.test.ts に
    //      「非adminでは書けない／adminなら書ける」の対照テストを追加する
    expect(adminUncovered).toEqual([])
  })

  it('rlsIdorNotRequired の各行に理由が書かれている', () => {
    // WHY: 除外は「負債の免除」ではなく「検知条件の訂正」。理由の無い除外を許すと、
    //      面倒な指摘をここに逃がすだけの穴になる（怪しいリストが空になって安心する罠）
    const withoutReason = baseline.rlsIdorNotRequired.filter((e) => !e.reason?.trim())
    expect(withoutReason).toEqual([])
  })

  it('rlsIdorNotRequired に、RLSポリシーを持たないテーブルが混ざっていない', () => {
    // WHY: テーブル名の打ち間違いや、ポリシーが消えた後の残骸を検知する
    const policyTables = findRlsTablesWithoutIdorTest({ allMigrationSql, idorTestSource: '' })
      .policyTables
    const unknown = baseline.rlsIdorNotRequired
      .map((e) => e.table)
      .filter((t) => !policyTables.includes(t))
    expect(unknown).toEqual([])
  })

  it('baselineに、既に解消済みの行が残っていない', () => {
    // WHY: 負債を返済したのにbaselineへ残し続けると、次に同じ穴が空いても検知されなくなる
    const staleCardinality = baseline.undeclaredCardinality.filter(
      (k) => !cardinalityKeys.includes(k),
    )
    const staleCoverage = baselineMigrations.filter((k) => !coverageKeys.includes(k))
    const staleRls = baselineRlsTables.filter((t) => !rlsUncovered.includes(t))
    expect({ staleCardinality, staleCoverage, staleRls }).toEqual({
      staleCardinality: [],
      staleCoverage: [],
      staleRls: [],
    })
  })

  it('baselineに書かれたriskが、現在の機械判定と一致している', () => {
    // WHY: 負債リストを「怪しい順」に見せるための risk が、書いたきり陳腐化しないようにする。
    //      裏方テーブル(low)をアプリが使い始めた等でriskが上がった場合、ここが落ちて気づける
    //      ＝「表面に出てこないまま放置される」を防ぐのがこのテストの役目
    const drifted = baseline.uncoveredIntegration
      .filter((e) => actualRisk.has(e.migration) && actualRisk.get(e.migration) !== e.risk)
      .map((e) => ({ migration: e.migration, baseline: e.risk, actual: actualRisk.get(e.migration) }))
    const driftedRls = baseline.rlsWithoutIdorTest
      .filter((e) => actualRlsRisk.has(e.table) && actualRlsRisk.get(e.table) !== e.risk)
      .map((e) => ({ table: e.table, baseline: e.risk, actual: actualRlsRisk.get(e.table) }))
    expect({ drifted, driftedRls }).toEqual({ drifted: [], driftedRls: [] })
  })
})
