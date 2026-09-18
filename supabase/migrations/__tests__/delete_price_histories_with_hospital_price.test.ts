import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 12（I-052）。施設削除で唯一残っていた price_histories（hospital_prices への FK が無い）を
//      親の削除に合わせて消すトリガーの中身を静的に固定する。実際に 0 件になることは
//      supabase/__tests__/integration/facility-delete-cascade.integration.test.ts が実 DB で確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000007_delete_price_histories_with_hospital_price.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-052
describe('20260906000007_delete_price_histories_with_hospital_price.sql [I-052]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('SECURITY DEFINER・search_path 空のトリガー関数が、親 hospital_prices の履歴だけを消す', () => {
    expect(n).toContain("create or replace function delete_price_histories_with_hospital_price() returns trigger language plpgsql security definer set search_path = ''")
    expect(n).toContain("delete from public.price_histories where entity_type = 'hospital_price' and entity_id = old.id;")
    expect(n).toContain('return old;')
  })

  it('AFTER DELETE ON hospital_prices の行トリガーとして付ける', () => {
    expect(n).toContain('create trigger hospital_prices_delete_price_histories after delete on hospital_prices for each row execute function delete_price_histories_with_hospital_price();')
  })

  it('既存の孤児行（親が無い hospital_price の履歴）を一度だけ掃除する', () => {
    expect(n).toContain("delete from price_histories ph where ph.entity_type = 'hospital_price' and not exists (select 1 from hospital_prices hp where hp.id = ph.entity_id);")
  })

  it('distributor_product の履歴（マスタ）には触れない', () => {
    expect(n).not.toContain("'distributor_product'")
  })

  it('テーブルの新設・削除を伴わない（baseline snapshot の更新は不要）', () => {
    expect(n).not.toMatch(/create table|drop table/)
  })
})
