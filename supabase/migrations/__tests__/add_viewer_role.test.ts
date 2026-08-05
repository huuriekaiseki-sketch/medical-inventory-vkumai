import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無い実行環境でも回帰を検知できるよう、生成したSQL
//      マイグレーションの中身を静的に検証する。実DB上の動作確認は別途
//      統合テスト(rbac-viewer-role.integration.test.ts)で行う。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_viewer_role.sql'))
    .sort()
    .at(-1)
}

describe('*_add_viewer_role.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('user_facilities.roleのCHECK制約にviewerを追加する', () => {
    expect(n).toContain('alter table user_facilities drop constraint user_facilities_role_check')
    expect(n).toContain("check (role in ('staff', 'admin', 'viewer'))")
  })

  it('is_facility_writer()ヘルパー関数を定義する(role staff/adminのみtrue)', () => {
    expect(n).toContain('create or replace function is_facility_writer(p_facility_id uuid)')
    expect(n).toContain("and role in ('staff', 'admin')")
  })

  it('書き込み系RLSポリシーをSELECT(member_or_admin)とALL(writer_or_admin)に分割する', () => {
    const tables = [
      'consumable_orders',
      'case_orders',
      'loan_orders',
      'loan_returns',
      'hospital_prices',
      'consumables',
    ]
    for (const t of tables) {
      expect(n).toContain(`drop policy if exists "facility_member_or_admin" on ${t}`)
      expect(n).toContain(`create policy "facility_member_or_admin" on ${t} for select to authenticated using (is_facility_member(facility_id) or is_admin())`)
      expect(n).toContain(`create policy "facility_writer_or_admin" on ${t} for all to authenticated using (is_facility_writer(facility_id) or is_admin()) with check (is_facility_writer(facility_id) or is_admin())`)
    }
  })

  it('facilitiesのUPDATEポリシーをwriter基準に変更する', () => {
    expect(n).toContain('drop policy if exists "facility_member_or_admin_update" on facilities')
    expect(n).toContain('create policy "facility_writer_or_admin_update" on facilities for update to authenticated using (is_facility_writer(id) or is_admin()) with check (is_facility_writer(id) or is_admin())')
  })

  it('itemsテーブル(親order経由)もSELECT/ALLに分割する', () => {
    const itemTables = [
      { table: 'case_order_items', parent: 'case_orders', fk: 'case_order_id' },
      { table: 'consumable_order_items', parent: 'consumable_orders', fk: 'consumable_order_id' },
      { table: 'loan_order_items', parent: 'loan_orders', fk: 'loan_order_id' },
      { table: 'loan_return_items', parent: 'loan_returns', fk: 'loan_return_id' },
    ]
    for (const { table, fk } of itemTables) {
      expect(n).toContain(`create policy "facility_writer_or_admin" on ${table}`)
      expect(n).toContain(`where o.id = ${table}.${fk}`)
    }
  })

  it('発注/返却系4RPCがis_facility_writerで認可チェックする(is_facility_memberは残さない)', () => {
    const occurrences = n.match(/if not (public\.)?is_facility_writer\(/g) ?? []
    expect(occurrences.length).toBe(4)
    expect(n).not.toMatch(/if not (public\.)?is_facility_member\(/)
  })

  it('resolve_jan_unit_priceは書き込みチェック対象外(再定義しない)', () => {
    expect(n).not.toContain('create or replace function resolve_jan_unit_price(')
  })

  it('create_loan_return_atomicがsearch_pathを空文字に固定し、テーブル参照をpublic.で完全修飾する(search_path hijacking対策)', () => {
    const startIdx = n.indexOf('create or replace function create_loan_return_atomic(')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    const fnBody = n.slice(startIdx)

    expect(fnBody).toContain('set search_path = \'\'')
    expect(fnBody).not.toContain('set search_path = public')
    expect(fnBody).toContain('v_return public.loan_returns%rowtype')
    expect(fnBody).toContain('if not public.is_facility_writer(v_facility_id) then')
    expect(fnBody).toContain('insert into public.loan_returns (facility_id, return_datetime, loan_order_id)')
    expect(fnBody).toContain('insert into public.loan_return_items (loan_return_id, jan, lot, ubd, quantity)')
    expect(fnBody).toContain('from public.loan_return_items i')
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
