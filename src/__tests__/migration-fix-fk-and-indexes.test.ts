import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// マイグレーション SQL を静的検証する。
// WHY: psql / Supabase CLI が CI 環境に無いため、実 DB で流す代わりに
// SQL ファイルの内容を読み取り「冪等性 (IF NOT EXISTS / IF EXISTS)」と
// 仕様で要求された DDL が含まれることを検証する。
const SQL_PATH = path.resolve(
  __dirname,
  '../../supabase/migrations/20260626000000_fix_fk_and_indexes.sql'
)

function readSql(): string {
  return readFileSync(SQL_PATH, 'utf-8')
}

// コメント行を除いた正規化済み小文字 SQL
function normalized(): string {
  return readSql()
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase()
}

describe('20260626000000_fix_fk_and_indexes.sql', () => {
  it('ファイルが存在し空でない', () => {
    expect(readSql().trim().length).toBeGreaterThan(0)
  })

  it('distributor_products.category_id FK を ON DELETE CASCADE で張り直す', () => {
    const sql = normalized()
    expect(sql).toContain('distributor_products_category_id_fkey')
    expect(sql).toMatch(
      /add constraint distributor_products_category_id_fkey[\s\S]*foreign key\s*\(category_id\)[\s\S]*references categories\s*\(id\)[\s\S]*on delete cascade/
    )
  })

  it('FK の DROP は IF EXISTS で冪等', () => {
    const sql = normalized()
    const dropConstraints = sql.match(/drop constraint[^,;]*/g) ?? []
    expect(dropConstraints.length).toBeGreaterThan(0)
    for (const dc of dropConstraints) {
      expect(dc).toContain('if exists')
    }
  })

  it('case/loan order items の jan が products(jan) を FK 参照する', () => {
    const sql = normalized()
    for (const table of [
      'case_order_items',
      'loan_order_items',
      'loan_return_items',
    ]) {
      expect(sql).toContain(`${table}_jan_fkey`)
      const re = new RegExp(
        `add constraint ${table}_jan_fkey[\\s\\S]*foreign key\\s*\\(jan\\)[\\s\\S]*references products\\s*\\(jan\\)`
      )
      expect(sql).toMatch(re)
    }
  })

  it('複合インデックスを IF NOT EXISTS で追加する', () => {
    const sql = normalized()
    const expected: Array<[string, string]> = [
      ['case_orders', 'facility_id, status'],
      ['case_orders', 'facility_id, created_at'],
      ['consumable_orders', 'facility_id, status'],
      ['loan_orders', 'facility_id, status'],
      ['loan_returns', 'facility_id, status'],
    ]
    for (const [table, cols] of expected) {
      const re = new RegExp(
        `create index if not exists \\S+ on ${table}\\s*\\(${cols.replace(
          ', ',
          ',\\s*'
        )}\\)`
      )
      expect(sql).toMatch(re)
    }
  })

  it('全 CREATE INDEX が IF NOT EXISTS で冪等', () => {
    const sql = normalized()
    const creates = sql.match(/create index[^;]*/g) ?? []
    expect(creates.length).toBeGreaterThanOrEqual(5)
    for (const c of creates) {
      expect(c).toContain('if not exists')
    }
  })

  it('order items 3テーブルに updated_at を IF NOT EXISTS で追加する', () => {
    const sql = normalized()
    for (const table of [
      'case_order_items',
      'loan_order_items',
      'loan_return_items',
    ]) {
      const re = new RegExp(
        `alter table ${table}\\s*\\n?\\s*add column if not exists updated_at timestamptz`
      )
      expect(sql).toMatch(re)
    }
  })

  it('追加する updated_at は DEFAULT now() を持つ', () => {
    const sql = normalized()
    const adds = sql.match(/add column if not exists updated_at[^;]*/g) ?? []
    expect(adds.length).toBe(3)
    for (const a of adds) {
      expect(a).toMatch(/default now\(\)/)
    }
  })
})
