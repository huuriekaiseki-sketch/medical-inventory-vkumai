import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC-tech-debt.md SET F/H, インデックス追加)を
//      満たすかを静的に検証することで、回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const MASTER_RLS_FILE = path.join(MIGRATIONS_DIR, '20260629000001_fix_master_rls.sql')
const LOAN_RETURN_RPC_FILE = path.join(MIGRATIONS_DIR, '20260629000002_loan_return_atomic_rpc.sql')
const INDEXES_FILE = path.join(MIGRATIONS_DIR, '20260629000003_add_indexes.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260629000001_fix_master_rls.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(MASTER_RLS_FILE)).toBe(true)
  })

  const sql = existsSync(MASTER_RLS_FILE) ? readFileSync(MASTER_RLS_FILE, 'utf-8') : ''
  const n = normalize(sql)

  const masterTables = ['products', 'categories', 'distributor_products']

  it.each(masterTables)('%s の auth_only ポリシーを DROP する', (table) => {
    expect(n).toContain(`drop policy if exists "auth_only" on ${table}`)
  })

  it.each(masterTables)('%s に select 用ポリシーを追加する（全認証ユーザー参照可）', (table) => {
    expect(n).toContain(`create policy "${table}_select" on ${table} for select to authenticated using (true)`)
  })

  it.each(masterTables)('%s に write 用ポリシーを追加する（admin のみ）', (table) => {
    expect(n).toContain(
      `create policy "${table}_write" on ${table} for all to authenticated using (is_admin()) with check (is_admin())`
    )
  })
})

describe('20260629000002_loan_return_atomic_rpc.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(LOAN_RETURN_RPC_FILE)).toBe(true)
  })

  const sql = existsSync(LOAN_RETURN_RPC_FILE) ? readFileSync(LOAN_RETURN_RPC_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('create_loan_return_atomic(p_header jsonb, p_items jsonb) を定義する', () => {
    expect(n).toContain('create or replace function create_loan_return_atomic(')
    expect(n).toContain('p_header jsonb')
    expect(n).toContain('p_items jsonb')
    expect(n).toContain('returns jsonb')
  })

  it('SECURITY DEFINER / search_path=public で定義する', () => {
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
  })

  it('is_facility_member() で施設チェックを行う', () => {
    expect(n).toContain('is_facility_member(')
    expect(n).toContain('raise exception')
  })

  it('loan_returns と loan_return_items を INSERT する（トランザクション化）', () => {
    expect(n).toContain('insert into loan_returns')
    expect(n).toContain('insert into loan_return_items')
  })

  it('authenticated に EXECUTE 権限を付与する', () => {
    expect(n).toContain('grant execute on function create_loan_return_atomic')
    expect(n).toContain('to authenticated')
  })
})

describe('20260629000003_add_indexes.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(INDEXES_FILE)).toBe(true)
  })

  const sql = existsSync(INDEXES_FILE) ? readFileSync(INDEXES_FILE, 'utf-8') : ''
  const n = normalize(sql)

  const expectedIndexes = [
    'create index if not exists idx_hospital_prices_facility_id on hospital_prices(facility_id)',
    'create index if not exists idx_consumables_facility_id on consumables(facility_id)',
    'create index if not exists idx_distributor_products_category_id on distributor_products(category_id)',
    'create index if not exists idx_price_histories_entity_id on price_histories(entity_id)',
    'create index if not exists idx_user_facilities_facility_id on user_facilities(facility_id)',
  ]

  it.each(expectedIndexes)('%s を含む', (stmt) => {
    expect(n).toContain(stmt)
  })
})
