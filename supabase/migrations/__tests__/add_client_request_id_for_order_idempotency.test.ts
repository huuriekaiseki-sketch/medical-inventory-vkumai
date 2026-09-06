import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 2（発注の冪等性、P-053）。client_request_id の列・部分 UNIQUE・RPC の再送処理を
//      migration の中身として静的に固定する。「同じ鍵で 2 回呼んでも 1 行」は
//      supabase/__tests__/integration/order-idempotency.integration.test.ts が実 DB で確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000006_add_client_request_id_for_order_idempotency.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

const TABLES = ['case_orders', 'loan_orders', 'consumable_orders', 'loan_returns'] as const

// 約束カタログ（docs/agents/promise-catalog.md）: P-053
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-034
describe('20260906000006_add_client_request_id_for_order_idempotency.sql [P-053 I-034]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it.each(TABLES)('%s に client_request_id UUID 列と (facility_id, client_request_id) の部分 UNIQUE を足す', (table) => {
    expect(n).toContain(`alter table ${table} add column client_request_id uuid;`)
    expect(n).toContain(
      `create unique index ${table}_client_request_id_unique on ${table} (facility_id, client_request_id) where client_request_id is not null;`,
    )
  })

  it('発注 3 RPC は旧シグネチャを DROP してから p_client_request_id uuid default null 付きで作り直し、GRANT を付け直す', () => {
    expect(n).toContain('drop function create_case_order_atomic(uuid, timestamptz, text, text, text, text, text, jsonb);')
    expect(n).toContain('drop function create_loan_order_atomic(uuid, text, text, jsonb);')
    expect(n).toContain('drop function create_consumable_order_atomic(uuid, jsonb);')
    expect(n).toContain('p_items jsonb, p_client_request_id uuid default null ) returns jsonb')
    expect(n).toContain('grant execute on function create_case_order_atomic(uuid, timestamptz, text, text, text, text, text, jsonb, uuid) to authenticated;')
    expect(n).toContain('grant execute on function create_loan_order_atomic(uuid, text, text, jsonb, uuid) to authenticated;')
    expect(n).toContain('grant execute on function create_consumable_order_atomic(uuid, jsonb, uuid) to authenticated;')
    expect(n).toContain('grant execute on function create_loan_return_atomic(jsonb, jsonb) to authenticated;')
  })

  it('返却 RPC はシグネチャを変えず p_header の client_request_id を読む', () => {
    expect(n).toContain("v_client_request_id uuid := nullif(p_header->>'client_request_id', '')::uuid;")
    expect(n).not.toContain('drop function create_loan_return_atomic')
  })

  it.each([
    ['create_case_order_atomic', 'case_orders'],
    ['create_loan_order_atomic', 'loan_orders'],
    ['create_consumable_order_atomic', 'consumable_orders'],
    ['create_loan_return_atomic', 'loan_returns'],
  ])('%s は認可チェックの後に鍵で既存行を探し、同時送信の unique_violation では相手の行を返す', (_fn, table) => {
    expect(n).toContain(`from public.${table} where facility_id =`)
    expect(n).toContain('exception when unique_violation then')
    expect(n).toContain("jsonb_build_object('items', v_items, 'replayed', v_replayed)")
  })

  it('4 RPC とも SECURITY DEFINER のまま search_path を空にし、is_facility_writer と has_aal2 を先に通す', () => {
    const bodies = n.split('create or replace function').slice(1)
    expect(bodies).toHaveLength(4)
    for (const body of bodies) {
      expect(body).toContain("security definer set search_path = ''")
      expect(body.indexOf('is_facility_writer')).toBeLessThan(body.indexOf('client_request_id ='))
      expect(body.indexOf('has_aal2')).toBeLessThan(body.indexOf('client_request_id ='))
    }
  })

  it('テーブルの新設・削除を伴わない（baseline snapshot の更新は不要）', () => {
    expect(n).not.toMatch(/create table|drop table/)
  })
})
