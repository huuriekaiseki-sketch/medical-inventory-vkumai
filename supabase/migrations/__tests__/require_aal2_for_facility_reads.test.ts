import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 39（B-001）。施設スコープの読み取りと監査ログの SELECT、および
//      admin の集計 RPC が has_aal2() を落とさないことを静的に固定する
//      （実 DB での挙動は blast-radius.integration.test.ts が測る）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_require_aal2_for_facility_reads.sql'))
    .sort()
    .at(-1)
}

const DIRECT_TABLES = [
  'consumable_orders',
  'case_orders',
  'loan_orders',
  'loan_returns',
  'hospital_prices',
  'consumables',
]
const ITEMS_TABLES: [string, string, string][] = [
  ['case_order_items', 'case_orders', 'case_order_id'],
  ['consumable_order_items', 'consumable_orders', 'consumable_order_id'],
  ['loan_order_items', 'loan_orders', 'loan_order_id'],
  ['loan_return_items', 'loan_returns', 'loan_return_id'],
]

// 約束カタログ（docs/agents/promise-catalog.md）: P-034 施設スコープの読み取りにも aal2
describe('施設スコープの SELECT と監査ログ・集計 RPC は has_aal2() を要求する [P-034]', () => {
  const file = findMigrationFile()

  it('migration ファイルが存在する', () => {
    expect(file).toBeDefined()
  })

  const raw = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : ''
  const sql = normalize(raw)

  it.each(DIRECT_TABLES)('%s の SELECT ポリシーが (member or admin) and has_aal2() になっている', (table) => {
    expect(sql).toContain(
      `create policy "facility_member_or_admin" on ${table} for select to authenticated using ((is_facility_member(facility_id) or is_admin()) and has_aal2())`
    )
  })

  it.each(ITEMS_TABLES)('%s は親 %s 経由の EXISTS の手前で has_aal2() を要求する', (table, parent, fk) => {
    expect(sql).toContain(
      `create policy "facility_member_or_admin" on ${table} for select to authenticated using (has_aal2() and exists ( select 1 from ${parent} o where o.id = ${table}.${fk} and (is_facility_member(o.facility_id) or is_admin()) ))`
    )
  })

  it('audit_log の SELECT にも has_aal2() が付いている', () => {
    expect(sql).toContain(
      'create policy audit_log_select on audit_log for select to authenticated using ((is_admin() or (facility_id is not null and is_facility_member(facility_id))) and has_aal2())'
    )
  })

  it('置き換える前に古いポリシーを DROP する（許可の広い方が残らない）', () => {
    for (const t of [...DIRECT_TABLES, ...ITEMS_TABLES.map(([t]) => t)]) {
      expect(sql).toContain(`drop policy if exists "facility_member_or_admin" on ${t}`)
    }
    expect(sql).toContain('drop policy if exists audit_log_select on audit_log')
  })

  it('SECURITY DEFINER の集計 RPC は admin 判定の後に has_aal2() を見る（判定順で情報を漏らさない）', () => {
    expect(sql).toContain('create or replace function get_order_amount_report(')
    const adminAt = sql.indexOf('if not is_admin() then')
    const aal2At = sql.indexOf('if not has_aal2() then')
    expect(adminAt).toBeGreaterThan(-1)
    expect(aal2At).toBeGreaterThan(adminAt)
  })

  it('集計 RPC は DROP せず CREATE OR REPLACE で置き換える（GRANT を落とさない）', () => {
    expect(sql).not.toContain('drop function get_order_amount_report')
  })

  it('テナント非分離が設計のものには触れない（マスタ・price_histories・facilities の SELECT）', () => {
    expect(sql).not.toContain('on products for select')
    expect(sql).not.toContain('on categories for select')
    expect(sql).not.toContain('on distributor_products for select')
    expect(sql).not.toContain('price_histories_select')
    expect(sql).not.toContain('create policy "facility_member_or_admin" on facilities')
  })

  it('リリース順序とロールバック手順が書いてある', () => {
    expect(raw).toContain('-- release-order: db-first')
    expect(raw).toContain('-- ROLLBACK:')
  })
})
