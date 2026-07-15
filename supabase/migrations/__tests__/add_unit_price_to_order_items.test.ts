import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set A)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      (supabase/migrations/__tests__/orders_history_prereqs.test.ts と同じ方針)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_unit_price_to_order_items.sql'))
    .sort()
    .at(-1)
}

describe('*_add_unit_price_to_order_items.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  const expectedColumns = [
    'alter table case_order_items add column unit_price numeric(12,2)',
    'alter table consumable_order_items add column unit_price numeric(12,2)',
    'alter table loan_order_items add column unit_price numeric(12,2)',
  ]

  it.each(expectedColumns)('%s を含む', (stmt) => {
    expect(n).toContain(stmt)
  })

  // WHY(重複・過剰実装指摘対応): case_ordersのidx_case_orders_facility_created_atは
  // 20260626000000_fix_fk_and_indexes.sqlで既に作成済み。同名でCREATE INDEX IF NOT EXISTSを
  // 再度書くと既存インデックス名と衝突して静かにno-opになる（死んだ文）ため、本migrationでは
  // 重複するインデックス作成を行わないことを回帰テストで固定する。
  it('case_ordersのインデックスを重複作成しない（既存のidx_case_orders_facility_created_atと衝突するため）', () => {
    expect(n).not.toContain('create index if not exists idx_case_orders_facility_created_at')
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
