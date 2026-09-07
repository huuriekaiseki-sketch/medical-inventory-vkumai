import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  auditedTablesFromMigrations,
  readersOf,
  scanTableFacts,
  writersOf,
} from '../../__tests__/helpers/table-facts'
import { TABLE_REGISTRY } from '../../__tests__/helpers/table-registry'

// WHY: 新しい表を作るときに決める 4 軸（RLS・ポリシー・権限・監査）を 1 枚で決め切らせる。
//      経緯と設計判断は supabase/__tests__/helpers/table-registry.ts の冒頭に書いた。
//      ここは「宣言と実態が一致しているか」を両方向で突き合わせるだけ。

/** これ以降に作る表は「既定に答えを委ねない」（明示 REVOKE → 必要な分だけ GRANT）を必須にする */
const EXPLICIT_REVOKE_REQUIRED_FROM = '20260906000000'

const INTEGRATION_DIR = path.resolve(__dirname, '../../__tests__/integration')

function integrationTestSources(): string {
  return readdirSync(INTEGRATION_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(INTEGRATION_DIR, f), 'utf-8'))
    .join('\n')
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-040 全テーブル RLS 有効・ポリシー最低 1 つ
describe('新しい表の 4 軸（RLS・ポリシー・権限・監査）を 1 枚で決め切る [P-040]', () => {
  const facts = scanTableFacts()
  const audited = auditedTablesFromMigrations()

  it('走査そのものが壊れていない（壊れると全件素通りして「合格」に見える）', () => {
    // fail-open 防止。表も権限も取れなくなったらここで落ちる
    expect(facts.size).toBeGreaterThanOrEqual(19)
    expect(readersOf(facts.get('audit_log')!)).toContain('authenticated')
    expect(writersOf(facts.get('user_facilities')!)).toEqual(['service_role'])
  })

  it('存在する全テーブルに宣言がある（新しい表はここで必ず止まる）', () => {
    const undeclared = [...facts.entries()]
      .filter(([name]) => !(name in TABLE_REGISTRY))
      .map(
        ([name, f]) =>
          `${name}（${f.createdIn} で追加。supabase/__tests__/helpers/table-registry.ts に 4 軸を書くこと）`,
      )
    expect(undeclared).toEqual([])
  })

  it('宣言に、存在しない表が残っていない（リスト陳腐化の検知）', () => {
    expect(Object.keys(TABLE_REGISTRY).filter((name) => !facts.has(name))).toEqual([])
  })

  it('「誰が読めるか」が宣言と一致する', () => {
    const mismatch: string[] = []
    for (const [name, decl] of Object.entries(TABLE_REGISTRY)) {
      const actual = readersOf(facts.get(name)!)
      if (actual.join(',') !== [...decl.reads].sort().join(','))
        mismatch.push(`${name}: 実際 [${actual}] / 宣言 [${[...decl.reads].sort()}]`)
    }
    expect(mismatch).toEqual([])
  })

  it('「誰が書けるか」が宣言と一致する', () => {
    const mismatch: string[] = []
    for (const [name, decl] of Object.entries(TABLE_REGISTRY)) {
      const actual = writersOf(facts.get(name)!)
      if (actual.join(',') !== [...decl.writes].sort().join(','))
        mismatch.push(`${name}: 実際 [${actual}] / 宣言 [${[...decl.writes].sort()}]`)
    }
    expect(mismatch).toEqual([])
  })

  it('ポリシーの有無が宣言と一致し、作らない表には理由がある', () => {
    const problems: string[] = []
    for (const [name, decl] of Object.entries(TABLE_REGISTRY)) {
      const count = facts.get(name)!.policyCount
      if (decl.policies === 'あり') {
        if (count === 0) problems.push(`${name}: ポリシーが 1 つも無い`)
      } else {
        if (count > 0) problems.push(`${name}: ポリシーが増えた（宣言を 'あり' に直すこと）`)
        if (decl.policies.trim().length <= 20) problems.push(`${name}: ポリシーを作らない理由が短すぎる`)
      }
    }
    expect(problems).toEqual([])
  })

  it('監査対象かが宣言と一致し、外す表には理由がある', () => {
    const problems: string[] = []
    for (const [name, decl] of Object.entries(TABLE_REGISTRY)) {
      const isAudited = audited.has(name)
      if (decl.audit === 'あり') {
        if (!isAudited) problems.push(`${name}: 監査トリガーが付いていない`)
      } else {
        if (isAudited) problems.push(`${name}: 監査対象になった（宣言を 'あり' に直すこと）`)
        if (decl.audit.trim().length <= 20) problems.push(`${name}: 監査から外す理由が短すぎる`)
        if (/todo|後で|あとで|未定/i.test(decl.audit)) problems.push(`${name}: 理由が仮置きのまま`)
      }
    }
    expect(problems).toEqual([])
  })

  it(`${EXPLICIT_REVOKE_REQUIRED_FROM} 以降に作る表は、既定の権限に答えを委ねず明示的に REVOKE してから GRANT する`, () => {
    // WHY: Supabase の既定権限（ALTER DEFAULT PRIVILEGES）が効くかどうかは環境で変わる。
    //      実測でも、効いている表（audit_log の注記）と効いていない表（schema_drift_log）の
    //      両方があった。「書いていないから安全」も「書いていないから使える」も成り立たない。
    const missing = [...facts.entries()]
      .filter(
        ([, f]) => f.createdIn >= EXPLICIT_REVOKE_REQUIRED_FROM && !f.revokedFromAllClientRoles,
      )
      .map(
        ([name, f]) =>
          `${name}（${f.createdIn}）: REVOKE ALL ON TABLE ${name} FROM PUBLIC, anon, authenticated, service_role; を書いてから必要な GRANT を書くこと`,
      )
    expect(missing).toEqual([])
  })

  it('ポリシーを持たない表は、実 DB で読める人・読めない人を確かめる統合テストがある', () => {
    // WHY: ポリシーが無い表は「RLS が弾いてくれる」が効かず、GRANT だけが境界になる。
    //      静的検査は GRANT の文字列しか見られないので、実際に読めるかは実 DB で測るしかない。
    //      schema_drift_log はこれが無かったために 2 か月間おかしいことに気づけなかった。
    const sources = integrationTestSources()
    const untested = Object.entries(TABLE_REGISTRY)
      .filter(([name, decl]) => decl.policies !== 'あり' && !sources.includes(name))
      .map(([name]) => `${name}: supabase/__tests__/integration/ のどれかで読み取り可否を測ること`)
    expect(untested).toEqual([])
  })
})
