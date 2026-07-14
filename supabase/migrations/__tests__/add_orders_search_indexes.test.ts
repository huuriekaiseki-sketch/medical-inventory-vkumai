import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 SET-A)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      (supabase/migrations/__tests__/add_products_name_maker.test.ts と同じ方針)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_orders_search_indexes.sql'))
    .sort()
    .at(-1)
}

describe('*_add_orders_search_indexes.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('すべてのCREATE INDEXがIF NOT EXISTSで冪等である', () => {
    const createIndexStatements = sql.match(/create\s+index[^;]*;/gi) ?? []
    expect(createIndexStatements.length).toBeGreaterThan(0)
    for (const stmt of createIndexStatements) {
      expect(stmt.toLowerCase()).toContain('if not exists')
    }
  })

  it('case_orders に (facility_id, case_datetime) の複合インデックスを追加する（既存の(facility_id, created_at)とは別）', () => {
    expect(n).toMatch(
      /create index if not exists \S+ on case_orders ?\(facility_id, ?case_datetime\)/
    )
  })

  it('consumable_orders に (facility_id, created_at) の複合インデックスを追加する', () => {
    expect(n).toMatch(
      /create index if not exists \S+ on consumable_orders ?\(facility_id, ?created_at\)/
    )
  })

  it('loan_orders に (facility_id, created_at) の複合インデックスを追加する', () => {
    expect(n).toMatch(
      /create index if not exists \S+ on loan_orders ?\(facility_id, ?created_at\)/
    )
  })

  it('loan_returns に (facility_id, return_datetime) の複合インデックスを追加する', () => {
    expect(n).toMatch(
      /create index if not exists \S+ on loan_returns ?\(facility_id, ?return_datetime\)/
    )
  })

  it('refresh_schema_baseline_snapshot は呼ばない（テーブル追加/削除を伴わないため）', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot/)
  })

  it('refresh_schema_baseline_snapshotを呼ばない根拠のコメントが1行ある', () => {
    expect(sql).toMatch(/--.*refresh_schema_baseline_snapshot/i)
  })
})
