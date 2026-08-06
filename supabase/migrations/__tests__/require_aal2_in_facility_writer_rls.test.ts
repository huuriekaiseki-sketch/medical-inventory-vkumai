import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無い実行環境でも回帰を検知できるよう、生成したSQL
//      マイグレーションの中身を静的に検証する。実DB上の動作確認は別途
//      ローカルSupabaseへのdb push + RLSからの直接書き込みで行う（このテストの対象外）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_require_aal2_in_facility_writer_rls.sql'))
    .sort()
    .at(-1)
}

const DIRECT_TABLES = [
  'consumable_orders',
  'case_orders',
  'loan_orders',
  'loan_returns',
  'hospital_prices',
  'consumables',
]
const ITEMS_TABLES = [
  'case_order_items',
  'consumable_order_items',
  'loan_order_items',
  'loan_return_items',
]

describe('*_require_aal2_in_facility_writer_rls.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('発注/返却4テーブル+価格/カタログ2テーブルのfacility_writer_or_adminポリシーを再定義する', () => {
    for (const t of DIRECT_TABLES) {
      expect(n).toContain(`drop policy if exists "facility_writer_or_admin" on ${t}`)
      expect(n).toContain(
        `create policy "facility_writer_or_admin" on ${t} for all to authenticated using ((is_facility_writer(facility_id) or is_admin()) and has_aal2()) with check ((is_facility_writer(facility_id) or is_admin()) and has_aal2())`
      )
    }
  })

  it('items系4テーブルのfacility_writer_or_adminポリシーにhas_aal2()を追加する', () => {
    for (const t of ITEMS_TABLES) {
      expect(n).toContain(`drop policy if exists "facility_writer_or_admin" on ${t}`)
      const occurrences = n.match(
        new RegExp(`create policy "facility_writer_or_admin" on ${t} for all to authenticated using \\( has_aal2\\(\\) and exists`, 'g')
      ) ?? []
      expect(occurrences.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('has_aal2()の出現回数は10テーブル×(using+with check)=20回', () => {
    const occurrences = n.match(/has_aal2\(\)/g) ?? []
    expect(occurrences.length).toBe(20)
  })

  it('facilitiesのfacility_writer_or_admin_updateポリシーは対象外のまま(意図的に除外)', () => {
    expect(n).not.toContain('facility_writer_or_admin_update')
  })

  it('is_facility_writerチェックを維持している(施設境界チェックの退行防止)', () => {
    const occurrences = n.match(/is_facility_writer\(/g) ?? []
    // 10テーブル × (using句 + with check句) = 20箇所
    expect(occurrences.length).toBe(20)
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
