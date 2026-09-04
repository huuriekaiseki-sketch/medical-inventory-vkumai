import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無い実行環境でも回帰を検知できるよう、生成したSQL
//      マイグレーションの中身を静的に検証する。実DB上の動作確認は別途
//      ローカルSupabaseへのdb push + RPC呼び出しで行う（このテストの対象外）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_require_aal2_for_order_rpcs.sql'))
    .sort()
    .at(-1)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-030 aal2 要求 / P-032 aal2 チェックは所属チェックの後 / P-041 search_path=''
describe('*_require_aal2_for_order_rpcs.sql [P-030 P-032 P-041]', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('has_aal2()ヘルパー関数を定義する(MFA未登録ユーザーはaal1のまま許可し、登録済みユーザーのみaal2を要求する)', () => {
    expect(n).toContain('create or replace function has_aal2()')
    expect(n).toContain('security definer')
    // MFA未登録(検証済みtotp factorが存在しない)なら常にtrueを返す
    expect(n).toContain('from auth.mfa_factors')
    expect(n).toContain("where user_id = auth.uid() and factor_type = 'totp' and status = 'verified'")
    expect(n).toContain('if not v_mfa_enrolled then')
    expect(n).toContain('return true')
    // MFA登録済みの場合のみ実際のaalクレームを検証する
    expect(n).toContain("return coalesce(auth.jwt() ->> 'aal', '') = 'aal2'")
  })

  it('既存migrationを追記せず、CREATE OR REPLACE FUNCTIONで発注/返却4RPCを再定義する', () => {
    expect(n).toContain('create or replace function create_case_order_atomic(')
    expect(n).toContain('create or replace function create_loan_order_atomic(')
    expect(n).toContain('create or replace function create_consumable_order_atomic(')
    expect(n).toContain('create or replace function create_loan_return_atomic(')
  })

  it('発注/返却4RPCすべてがhas_aal2()チェックを追加している', () => {
    const occurrences = n.match(/if not public\.has_aal2\(\) then/g) ?? []
    expect(occurrences.length).toBe(4)
  })

  it('is_facility_writerチェックを維持している(施設境界チェックの退行防止)', () => {
    const occurrences = n.match(/if not public\.is_facility_writer\(/g) ?? []
    expect(occurrences.length).toBe(4)
  })

  it('aal2チェックはfacility_writerチェックの後に来る(施設非所属者にもaal2要求メッセージを誤って先出ししない)', () => {
    const caseOrderIdx = n.indexOf('create or replace function create_case_order_atomic(')
    const body = n.slice(caseOrderIdx)
    const writerIdx = body.indexOf('if not public.is_facility_writer(')
    const aalIdx = body.indexOf('if not public.has_aal2() then')
    expect(writerIdx).toBeGreaterThanOrEqual(0)
    expect(aalIdx).toBeGreaterThan(writerIdx)
  })

  it('search_pathはすべて空文字で完全修飾を維持している(search_path hijacking対策の退行防止)', () => {
    const occurrences = n.match(/set search_path = ''/g) ?? []
    // has_aal2 + 発注/返却4RPC = 5関数
    expect(occurrences.length).toBe(5)
    expect(n).not.toContain('set search_path = public')
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
