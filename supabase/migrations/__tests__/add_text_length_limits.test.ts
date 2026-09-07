import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 20・32（I-060〜I-065）。長さの上限が消えたり緩んだりしないことを静的に固定する
//      （実 DB の挙動は text-length-limits.integration.test.ts）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_text_length_limits.sql'))
    .sort()
    .at(-1)
}

const TABLES = [
  'case_orders',
  'loan_orders',
  'case_order_items',
  'loan_order_items',
  'loan_return_items',
  'consumables',
  'facilities',
  'products',
  'categories',
  'distributor_products',
]

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-060〜I-065 入力の長さ
describe('自由入力の TEXT 列に長さの CHECK がある [I-060 I-061 I-062 I-063 I-064 I-065]', () => {
  const file = findMigrationFile()

  it('migration ファイルが存在する', () => {
    expect(file).toBeDefined()
  })

  const raw = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : ''
  const sql = normalize(raw)

  it.each(TABLES)('%s に長さの CHECK がある', (table) => {
    expect(sql).toContain(`alter table ${table} add constraint ${table}_text_length check (`)
  })

  it('すべて NOT VALID で入れる（既存行を読むと書き込みが止まるため）', () => {
    // CHECK の中に length(...) の括弧が入るので、非貪欲で ") not valid" までを 1 件として数える
    const withNotValid = sql.match(/add constraint [a-z_]+_text_length check \(.*?\) not valid/g) ?? []
    const all = sql.match(/add constraint [a-z_]+_text_length check \(/g) ?? []
    expect(all.length).toBe(TABLES.length)
    expect(withNotValid.length).toBe(TABLES.length)
  })

  it('患者情報の列に上限がある（患者 ID・イニシャル・医師名・術式名）', () => {
    expect(sql).toContain('length(procedure_name) <= 200')
    expect(sql).toContain('length(patient_id) <= 100')
    expect(sql).toContain('length(patient_initials) <= 20')
    expect(sql).toContain('length(doctor_name) <= 100')
  })

  it('NULL を許す列は NULL チェック付きで書く（NOT NULL でない列を誤って必須にしない）', () => {
    expect(sql).toContain('lot is null or length(lot) <= 100')
    expect(sql).toContain('ubd is null or length(ubd) <= 100')
    expect(sql).toContain('jan is null or length(jan) <= 64')
  })

  it('リリース順序とロールバック手順が書いてある', () => {
    expect(raw).toContain('-- release-order: db-first')
    expect(raw).toContain('-- ROLLBACK:')
  })
})
