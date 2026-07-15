import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set B)を
//      満たすかを静的に検証することで、回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_order_amount_report_rpc.sql'))
    .sort()
    .at(-1)
}

describe('*_add_order_amount_report_rpc.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('get_order_amount_report(p_date_from TIMESTAMPTZ, p_date_to TIMESTAMPTZ)を定義する', () => {
    expect(n).toContain('create or replace function get_order_amount_report( p_date_from timestamptz, p_date_to timestamptz )'.replace(/ +/g, ' '))
  })

  it('戻り値の11列すべてを定義する（*_total_countは発注0件と金額データなしを区別するための列）', () => {
    for (const col of [
      'facility_id uuid',
      'facility_name text',
      'case_order_amount numeric',
      'case_order_count integer',
      'case_order_total_count integer',
      'consumable_order_amount numeric',
      'consumable_order_count integer',
      'consumable_order_total_count integer',
      'loan_order_amount numeric',
      'loan_order_count integer',
      'loan_order_total_count integer',
    ]) {
      expect(n).toContain(col)
    }
  })

  it('*_total_countは単価の有無を問わない全明細件数(COUNT(*))として定義される', () => {
    expect((n.match(/count\(\*\) as total_cnt/g) ?? []).length).toBe(3)
  })

  it('SECURITY DEFINERかつSET search_path = publicで、is_admin()チェックを持つ', () => {
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
    expect(n).toContain('if not is_admin() then')
    expect(n).toContain("raise exception 'permission denied'")
  })

  it('facilitiesを起点にLEFT JOINし全施設が出力される設計になっている', () => {
    expect(n).toContain('from facilities f')
    expect(n).toContain('left join')
  })

  it('各発注種別のWHERE句が期間フィルタ(NULL許容)になっている', () => {
    const occurrences = n.match(/\(p_date_from is null or .*?>= p_date_from\)/g) ?? []
    expect(occurrences.length).toBe(3)
  })

  it('unit_priceがNULLの明細を除外してSUM/COUNTし、結果をCOALESCEしない(UI側で判定するためNULLのまま返す)', () => {
    expect(n).toContain('filter (where coi.unit_price is not null)')
    expect(n).toContain('filter (where loi.unit_price is not null)')
    // amountカラム自体はCOALESCEしない(NULLのまま返す)。count側のみCOALESCE(..., 0)する。
    expect(n).not.toMatch(/coalesce\(co_agg\.amount/)
    expect(n).not.toMatch(/coalesce\(cons_agg\.amount/)
    expect(n).not.toMatch(/coalesce\(loan_agg\.amount/)
  })

  it('GRANT EXECUTEはauthenticated/service_roleのみでanonを含まない', () => {
    expect(n).toContain('grant execute on function get_order_amount_report(timestamptz, timestamptz) to authenticated, service_role')
    expect(n).not.toMatch(/grant execute on function get_order_amount_report[^;]*anon/)
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
