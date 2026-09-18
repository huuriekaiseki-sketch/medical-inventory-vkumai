import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY(2026-09-10): 契約 O-052 は「代理店商品は admin + aal2 が消せる」だが、
//      仕切値を一度でも変えた商品は `price_histories` からの FK（ON DELETE 指定なし）に
//      止められて**誰にも消せなかった**。統合テストの後片付けを機械で測って見つけた
//      （後片付けの削除が毎回 23503 で失敗し、それを誰も見ていなかった）。
//      院内価格側（20260906000007）と同じ「親が消えたら履歴も消す」規則を、
//      もう一方の親にも適用する。実 DB での挙動は
//      supabase/__tests__/integration/business-invariants.integration.test.ts が測る。

const FILE = path.join(
  path.resolve(__dirname, '..'),
  '20260910000000_delete_price_histories_with_distributor_product.sql'
)

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-037
describe('20260910000000_delete_price_histories_with_distributor_product.sql [I-037]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('SECURITY DEFINER・search_path 空のトリガー関数になっている', () => {
    expect(n).toContain(
      "create or replace function delete_price_histories_with_distributor_product() returns trigger language plpgsql security definer set search_path = ''"
    )
    expect(n).toContain('return old;')
  })

  // WHY(2 つの列を両方見ることを固定する): この表は entity_type/entity_id の緩い参照と
  //      distributor_product_id の実 FK を**両方**持つ。片方だけ消すと、
  //      FK は外れるのに孤児が残る（または孤児は消えるのに FK が外れず削除が止まる）。
  it('実 FK の列と、緩い参照（entity_type / entity_id）の両方を消す', () => {
    expect(n).toContain('delete from public.price_histories where distributor_product_id = old.id')
    expect(n).toContain("or (entity_type = 'distributor_product' and entity_id = old.id)")
  })

  // WHY(BEFORE であることを固定する): 院内価格側は FK が無いので AFTER で足りたが、
  //      こちらは実在の FK があるため、**行が消える前に**参照を外さないと 23503 で止まる。
  it('BEFORE DELETE の行トリガーとして付ける（AFTER では FK に間に合わない）', () => {
    expect(n).toContain(
      'create trigger distributor_products_delete_price_histories before delete on distributor_products for each row execute function delete_price_histories_with_distributor_product();'
    )
    expect(n).not.toContain('after delete on distributor_products')
  })

  it('既存の孤児行（親が無いマスタの履歴）を一度だけ掃除する', () => {
    expect(n).toContain(
      "delete from price_histories ph where ph.entity_type = 'distributor_product' and not exists (select 1 from distributor_products dp where dp.id = ph.entity_id);"
    )
  })

  it('hospital_price の履歴には触れない（そちらは 20260906000007 の担当）', () => {
    expect(n).not.toContain("'hospital_price'")
  })

  it('release-order と ROLLBACK が書いてある', () => {
    const raw = existsSync(FILE) ? readFileSync(FILE, 'utf-8') : ''
    expect(raw).toContain('-- release-order: db-first')
    expect(raw).toContain('-- ROLLBACK:')
  })

  it('テーブルの新設・削除を伴わない（baseline snapshot の更新は不要）', () => {
    expect(n).not.toMatch(/create table|drop table/)
  })
})
