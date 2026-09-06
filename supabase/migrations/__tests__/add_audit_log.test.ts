import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 4 / 24。監査ログ migration の骨格（append-only の権限とトリガー、記録トリガーの
//      付与先、baseline 更新）を静的に固定する。「本当に残る・本当に消せない」は
//      supabase/__tests__/integration/audit-log-rls-idor.integration.test.ts が実 DB で確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000004_add_audit_log.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

const AUDITED_TABLES = [
  'case_orders', 'case_order_items', 'consumable_orders', 'consumable_order_items',
  'loan_orders', 'loan_order_items', 'loan_returns', 'loan_return_items',
  'consumables', 'hospital_prices', 'user_facilities', 'facilities',
  'products', 'distributor_products', 'categories', 'product_compatibilities',
]

// 約束カタログ（docs/agents/promise-catalog.md）: P-060 全経路で残る / P-061 append-only / P-062 施設境界
describe('20260906000004_add_audit_log.sql [P-060 P-061 P-062]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('audit_log を作り RLS を有効化し、SELECT ポリシーだけを持つ', () => {
    expect(n).toContain('create table audit_log')
    expect(n).toContain('alter table audit_log enable row level security')
    expect(n).toContain('create policy audit_log_select on audit_log for select to authenticated using (is_admin() or (facility_id is not null and is_facility_member(facility_id)))')
    expect(n).not.toMatch(/create policy \w+ on audit_log for (insert|update|delete|all)/)
  })

  it('Supabase 既定権限を 3 ロールとも REVOKE し、SELECT だけを戻す', () => {
    expect(n).toContain('revoke all on table audit_log from public, anon, authenticated, service_role;')
    expect(n).toContain('grant select on table audit_log to authenticated, service_role;')
    expect(n).not.toMatch(/grant (insert|update|delete|all)[^;]*on table audit_log/)
  })

  it('UPDATE / DELETE / TRUNCATE を拒否するトリガーが insufficient_privilege を投げる', () => {
    expect(n).toContain("using errcode = 'insufficient_privilege'")
    expect(n).toContain('create trigger audit_log_no_update_delete before update or delete on audit_log for each row execute function audit_log_immutable();')
    expect(n).toContain('create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_immutable();')
  })

  it('記録トリガーは SECURITY DEFINER・search_path 空で、同値 UPDATE を記録しない', () => {
    expect(n).toContain('create or replace function audit_row_change() returns trigger language plpgsql security definer set search_path = \'\'')
    expect(n).toContain('if v_changed is null then return null; end if;')
    // updated_at は毎回変わる派生値なので差分から除く（除かないと同値 UPDATE が記録される。実測で踏んだ）
    expect(n).toContain("where n.key <> 'updated_at' and v_old -> n.key is distinct from n.value")
    expect(n).toContain('insert into public.audit_log (table_name, row_id, facility_id, action, actor_id, actor_role, old_data, new_data, changed_columns)')
  })

  it.each(AUDITED_TABLES)('%s に記録トリガーを付ける（FOREACH の一覧に含む）', (table) => {
    expect(n).toMatch(new RegExp(`foreach t in array array\\[[^\\]]*'${table}'`))
  })

  it('price_histories と audit_log 自身は記録対象に含めない', () => {
    const list = n.match(/foreach t in array array\[([^\]]*)\]/)?.[1] ?? ''
    expect(list).not.toContain("'price_histories'")
    expect(list).not.toContain("'audit_log'")
  })

  it('テーブル新設なので baseline snapshot を更新する', () => {
    expect(n).toContain("select refresh_schema_baseline_snapshot('20260906000004');")
  })
})
