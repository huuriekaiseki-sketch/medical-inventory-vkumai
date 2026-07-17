import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #458の回帰テスト。get_distributor_product_price_history RPC(SECURITY DEFINER)が
// hospital_price側のWHERE句にOR is_admin()を持つことを静的に固定する。
// ローカルSupabaseでの実機検証(admin/非member/施設memberの3パターンでRLS境界を確認、PASS済み)は
// 別途手動で実施済みだが、CI環境では実DB接続が無いため、admin_rls.test.tsと同じパターンで
// マイグレーションファイルの内容を静的に検証する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const FIX_FILE = path.join(MIGRATIONS_DIR, '20260718000001_fix_price_history_admin_access.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260718000001_fix_price_history_admin_access.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FIX_FILE)).toBe(true)
  })

  const sql = existsSync(FIX_FILE) ? readFileSync(FIX_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('get_distributor_product_price_history をCREATE OR REPLACEで再定義する', () => {
    expect(n).toContain('create or replace function get_distributor_product_price_history(')
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
  })

  it('hospital_price側のブランチでOR is_admin()を含む施設チェックになっている', () => {
    // WHY: is_facility_member単独ではなく、OR is_admin()と組み合わせた条件になっていることを
    // 確認する(単にis_admin()という文字列が別の場所にあるだけでは合格させない)
    expect(n).toMatch(/\(is_facility_member\(hp\.facility_id\)\s+or\s+is_admin\(\)\)/)
  })

  it('distributor_product側のブランチ(施設非依存)は変更しない', () => {
    expect(n).toContain("where ph.entity_type = 'distributor_product'")
    expect(n).toContain("and ph.distributor_product_id = p_distributor_product_id")
  })
})
