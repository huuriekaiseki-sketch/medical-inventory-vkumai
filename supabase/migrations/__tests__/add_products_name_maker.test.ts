import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set A)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      (supabase/migrations/__tests__/tech_debt_migrations.test.ts と同じ方針)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_products_name_maker.sql'))
    .sort()
    .at(-1)
}

describe('*_add_products_name_maker.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('products テーブルに name カラムを NOT NULL DEFAULT \'\' で追加する', () => {
    expect(n).toContain("add column name text not null default ''")
  })

  it('products テーブルに maker カラムを NULL 許可で追加する（NOT NULL を含まない）', () => {
    expect(n).toMatch(/add column maker text(?!\s+not\s+null)/)
  })

  it('ALTER TABLE products に対する変更である', () => {
    expect(n).toContain('alter table products')
  })
})
