import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(architecture review 2026-07-26 issue #2)を
//      満たすかを静的に検証することで、回帰テストとして固定する
//      (add_unit_price_snapshot_to_order_rpcs.test.tsと同じ静的検証パターン)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_loan_order_id_to_loan_return_atomic_rpc.sql'))
    .sort()
    .at(-1)
}

describe('*_add_loan_order_id_to_loan_return_atomic_rpc.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('既存migrationを追記せず、CREATE OR REPLACE FUNCTIONでcreate_loan_return_atomicを再定義する', () => {
    expect(n).toContain('create or replace function create_loan_return_atomic(')
  })

  it('is_facility_memberチェックを維持している（施設境界チェックの退行防止）', () => {
    const occurrences = n.match(/if not is_facility_member\(v_facility_id\) then/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(1)
  })

  it('loan_returnsのinsertにloan_order_idを含む(未返却誤判定バグの修正がRPC側にも反映されている)', () => {
    expect(n).toContain('insert into loan_returns (facility_id, return_datetime, loan_order_id)')
  })

  it('v_loan_order_idはp_headerから取得している(JS側で検証済みの値をそのまま使う)', () => {
    expect(n).toContain("v_loan_order_id uuid := nullif(p_header->>'loan_order_id', '')::uuid;")
  })
})
