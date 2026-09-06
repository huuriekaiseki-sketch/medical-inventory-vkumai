import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 3。不変条件カタログ（docs/agents/invariant-catalog.md）の I-01x / I-020 を DB 制約に
//      落とした migration の中身を静的に固定する。「破ろうとしたら拒否される」は
//      supabase/__tests__/integration/business-invariants.integration.test.ts が実 DB で確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000003_add_business_invariant_checks.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-010 I-011 I-012 I-013 I-014 I-020
describe('20260906000003_add_business_invariant_checks.sql [I-010 I-011 I-012 I-013 I-014 I-020]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it.each([
    ['case_order_items', 'case_order_items_quantity_positive', 'check (quantity > 0)'],
    ['consumable_order_items', 'consumable_order_items_quantity_positive', 'check (quantity > 0)'],
    ['loan_order_items', 'loan_order_items_quantity_positive', 'check (quantity > 0)'],
    ['loan_return_items', 'loan_return_items_quantity_positive', 'check (quantity > 0)'],
    ['case_order_items', 'case_order_items_unit_price_nonnegative', 'check (unit_price is null or unit_price >= 0)'],
    ['consumable_order_items', 'consumable_order_items_unit_price_nonnegative', 'check (unit_price is null or unit_price >= 0)'],
    ['loan_order_items', 'loan_order_items_unit_price_nonnegative', 'check (unit_price is null or unit_price >= 0)'],
    ['hospital_prices', 'hospital_prices_prices_nonnegative', 'check (purchase_price >= 0 and delivery_price >= 0)'],
    ['distributor_products', 'distributor_products_quantity_positive', 'check (quantity > 0)'],
    ['distributor_products', 'distributor_products_reimbursement_price_nonnegative', 'check (reimbursement_price is null or reimbursement_price >= 0)'],
  ])('%s に %s を NOT VALID で追加する', (table, name, check) => {
    expect(n).toContain(`alter table ${table} add constraint ${name} ${check} not valid;`)
  })

  it('状態を戻す更新を拒否するトリガー関数が check_violation を投げ、search_path を空にしている', () => {
    expect(n).toContain('create or replace function enforce_status_forward_only() returns trigger')
    expect(n).toContain("set search_path = ''")
    expect(n).toContain("old.status is distinct from new.status and old.status <> 'draft'")
    expect(n).toContain("using errcode = 'check_violation'")
  })

  it.each(['case_orders', 'consumable_orders', 'loan_orders', 'loan_returns'])(
    '%s に BEFORE UPDATE OF status のトリガーを付ける',
    (table) => {
      expect(n).toContain(`create trigger ${table}_status_forward_only before update of status on ${table} for each row execute function enforce_status_forward_only();`)
    },
  )

  it('テーブルの新設・削除を伴わない（baseline snapshot の更新は不要）', () => {
    expect(n).not.toMatch(/create table|drop table/)
  })
})
