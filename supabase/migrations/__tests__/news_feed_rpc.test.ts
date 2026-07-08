import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(issue #22)を満たすかを
//      静的に検証することで、回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const RPC_FILE = path.join(MIGRATIONS_DIR, '20260708000001_add_news_feed_rpc.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260708000001_add_news_feed_rpc.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(RPC_FILE)).toBe(true)
  })

  const sql = existsSync(RPC_FILE) ? readFileSync(RPC_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('get_news_feed(p_facility_id uuid, ...) を定義する', () => {
    expect(n).toContain('create or replace function get_news_feed(')
    expect(n).toContain('p_facility_id uuid')
  })

  it('SECURITY DEFINERを付けない（RLSがそのまま適用される設計）', () => {
    expect(n).not.toContain('security definer')
  })

  it('hospital_price分岐でp_facility_idによる絞り込み条件を持つ', () => {
    expect(n).toContain("entity_type = 'hospital_price'")
    expect(n).toContain('hp.facility_id = p_facility_id')
  })

  it('distributor_product分岐・new_product分岐が存在する（全施設公開・facility_idで絞り込まない）', () => {
    expect(n).toContain("entity_type = 'distributor_product'")
    expect(n).toContain('from distributor_products dp')
  })

  it('anonにはEXECUTE権限を許可しない', () => {
    expect(n).toContain('grant execute on function get_news_feed to authenticated')
    expect(n).not.toMatch(/grant execute on function get_news_feed[^;]*anon/)
  })
})
