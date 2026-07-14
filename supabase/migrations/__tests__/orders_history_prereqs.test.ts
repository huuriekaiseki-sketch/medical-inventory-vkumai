import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set A)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      (supabase/migrations/__tests__/add_products_name_maker.test.ts と同じ方針)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_orders_history_prereqs.sql'))
    .sort()
    .at(-1)
}

describe('*_orders_history_prereqs.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('loan_returns に loan_order_id 列を追加する', () => {
    expect(n).toContain('alter table loan_returns')
    expect(n).toContain('add column loan_order_id uuid references loan_orders(id) on delete set null')
  })

  it('loan_order_id は NOT NULL を含まない（NULL許容・既存行の後方互換）', () => {
    expect(n).toMatch(/add column loan_order_id uuid references loan_orders\(id\) on delete set null(?!\s+not\s+null)/)
  })

  const expectedIndexes = [
    'create index if not exists idx_consumable_orders_facility_created_at on consumable_orders (facility_id, created_at desc)',
    'create index if not exists idx_loan_orders_facility_created_at on loan_orders (facility_id, created_at desc)',
    'create index if not exists idx_loan_returns_facility_created_at on loan_returns (facility_id, created_at desc)',
  ]

  it.each(expectedIndexes)('%s を含む', (stmt) => {
    expect(n).toContain(stmt)
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    // WHY: コメントで呼び出し要否を説明している場合があるため、実際の呼び出し
    //      (select refresh_schema_baseline_snapshot(...)) の有無だけを見る
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
