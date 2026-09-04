import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(issue #4)を満たすかを
//      静的に検証することで、RLS完全化の構造を回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const ROLE_FILE = path.join(MIGRATIONS_DIR, '20260628010000_add_role_to_user_facilities.sql')
const RLS_FILE = path.join(MIGRATIONS_DIR, '20260628010001_update_rls_admin.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260628010000_add_role_to_user_facilities.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(ROLE_FILE)).toBe(true)
  })

  const sql = existsSync(ROLE_FILE) ? readFileSync(ROLE_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('user_facilities に role カラムを NOT NULL DEFAULT staff で追加する', () => {
    expect(n).toContain("add column")
    expect(n).toMatch(/role text not null default 'staff'/)
    expect(n).toContain('alter table user_facilities')
  })

  it("role の CHECK 制約 (staff/admin) を持つ", () => {
    expect(n).toMatch(/check\s*\(\s*role in \('staff', 'admin'\)\s*\)/)
    expect(n).toContain('user_facilities_role_check')
  })

  it('is_admin() 関数を SECURITY DEFINER / STABLE / search_path=public で定義する', () => {
    expect(n).toContain('create or replace function is_admin()')
    expect(n).toContain('returns boolean')
    expect(n).toContain('language sql')
    expect(n).toContain('stable')
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
  })

  it('is_admin() は user_facilities の role=admin を auth.uid() でチェックする', () => {
    expect(n).toContain('from user_facilities')
    expect(n).toContain('user_id = auth.uid()')
    expect(n).toMatch(/role = 'admin'/)
  })
})

// 約束カタログ（docs/agents/promise-catalog.md）: P-021 マスタの書き込みは admin だけ（is_admin() の導入）
describe('20260628010001_update_rls_admin.sql [P-021]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(RLS_FILE)).toBe(true)
  })

  const sql = existsSync(RLS_FILE) ? readFileSync(RLS_FILE, 'utf-8') : ''
  const n = normalize(sql)

  const directTables = [
    'consumable_orders',
    'case_orders',
    'loan_orders',
    'loan_returns',
    'hospital_prices',
    'consumables',
    'facilities',
  ]

  it.each(directTables)('%s で facility_member_only を DROP する', (table) => {
    expect(n).toContain(`drop policy if exists "facility_member_only" on ${table}`)
  })

  it.each(directTables)('%s に facility_member_or_admin ポリシーを作る', (table) => {
    expect(n).toContain(`create policy "facility_member_or_admin" on ${table}`)
  })

  const directWithFacilityId = [
    'consumable_orders',
    'case_orders',
    'loan_orders',
    'loan_returns',
    'hospital_prices',
    'consumables',
  ]

  it.each(directWithFacilityId)('%s は is_facility_member(facility_id) OR is_admin() を USING/WITH CHECK に持つ', (table) => {
    // テーブルごとのポリシー本文を抜き出して検証
    const re = new RegExp(`create policy "facility_member_or_admin" on ${table}[\\s\\S]*?with check[^;]*;`, 'i')
    const block = sql.match(re)?.[0] ?? ''
    const bn = normalize(block)
    expect(bn).toContain('for all to authenticated')
    expect(bn).toContain('using (is_facility_member(facility_id) or is_admin())')
    expect(bn).toContain('with check (is_facility_member(facility_id) or is_admin())')
  })

  it('facilities は SELECT / INSERT / UPDATE に分けて is_admin() を含める', () => {
    expect(n).toContain('create policy "facility_member_or_admin" on facilities for select to authenticated')
    expect(n).toContain('is_facility_member(id) or is_admin()')
    // INSERT は admin のみ（POST /api/facilities が createServerSupabase を使うため必須）
    expect(n).toContain('create policy "admin_insert" on facilities')
    expect(n).toContain('for insert to authenticated')
    expect(n).toContain('with check (is_admin())')
    // UPDATE 用ポリシーも存在する
    expect(n).toMatch(/on facilities\s+for update to authenticated/)
  })

  const itemsTables: Array<[string, string, string]> = [
    ['case_order_items', 'case_orders', 'case_order_id'],
    ['consumable_order_items', 'consumable_orders', 'consumable_order_id'],
    ['loan_order_items', 'loan_orders', 'loan_order_id'],
    ['loan_return_items', 'loan_returns', 'loan_return_id'],
  ]

  it.each(itemsTables)('%s は親 %s 経由で is_admin() を含む', (table, parent, fk) => {
    expect(n).toContain(`drop policy if exists "facility_member_only" on ${table}`)
    expect(n).toContain(`create policy "facility_member_or_admin" on ${table}`)
    expect(n).toContain(`from ${parent} o`)
    expect(n).toContain(`o.id = ${table}.${fk}`)
    expect(n).toContain('is_facility_member(o.facility_id) or is_admin()')
  })

  it('price_histories は hospital_price 分岐に is_admin() を追加し distributor_product は true のまま', () => {
    expect(n).toContain('drop policy if exists "facility_member_only" on price_histories')
    expect(n).toContain('create policy "facility_member_or_admin" on price_histories for select to authenticated')
    expect(n).toContain("when entity_type = 'hospital_price' then")
    expect(n).toContain('is_facility_member(hp.facility_id) or is_admin()')
    expect(n).toContain("when entity_type = 'distributor_product' then true")
  })
})
