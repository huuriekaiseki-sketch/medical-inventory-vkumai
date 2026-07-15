import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set A-2)を
//      満たすかを静的に検証することで、回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_unit_price_snapshot_to_order_rpcs.sql'))
    .sort()
    .at(-1)
}

describe('*_add_unit_price_snapshot_to_order_rpcs.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('既存migrationを追記せず、CREATE OR REPLACE FUNCTIONで3つのRPCを再定義する', () => {
    expect(n).toContain('create or replace function create_case_order_atomic(')
    expect(n).toContain('create or replace function create_loan_order_atomic(')
    expect(n).toContain('create or replace function create_consumable_order_atomic(')
  })

  it('is_facility_memberチェックを維持している（施設境界チェックの退行防止）', () => {
    const occurrences = n.match(/if not is_facility_member\(p_facility_id\) then/g) ?? []
    expect(occurrences.length).toBe(3)
  })

  it('resolve_jan_unit_priceにGRANT EXECUTEが明示的に付与されている（暗黙のPUBLIC権限に依存しない）', () => {
    expect(n).toContain('grant execute on function resolve_jan_unit_price(text, uuid) to authenticated')
  })

  it('resolve_jan_unit_price内でjan→products→distributor_products→hospital_pricesの経路でunit_priceを解決する', () => {
    expect(n).toContain('from products p')
    expect(n).toContain('join distributor_products dp on dp.product_id = p.id')
    expect(n).toContain('join hospital_prices hp')
    expect(n).toContain('hp.distributor_product_id = dp.id')
    expect(n).toContain('hp.facility_id = p_facility_id')
  })

  it('case_order_itemsとloan_order_itemsはそれぞれresolve_jan_unit_price(elem->>\'jan\', p_facility_id)を呼び出す', () => {
    expect(n).toContain("insert into case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price) select v_order.id, elem->>'jan', elem->>'lot', elem->>'ubd', coalesce((elem->>'quantity')::integer, 1), resolve_jan_unit_price(elem->>'jan', p_facility_id)")
    expect(n).toContain("insert into loan_order_items (loan_order_id, jan, name, quantity, unit_price) select v_order.id, elem->>'jan', elem->>'name', coalesce((elem->>'quantity')::integer, 1), resolve_jan_unit_price(elem->>'jan', p_facility_id)")
  })

  it('consumable_order_itemsはconsumable_id→consumables(jan)の経路でjanを求め、resolve_jan_unit_price(products→distributor_products→hospital_prices経路)に委譲する', () => {
    expect(n).toContain('from consumables c')
    expect(n).toContain('resolve_jan_unit_price(c.jan, p_facility_id)')
  })

  // WHY(重複実装指摘対応): case_order_itemsとloan_order_itemsは全く同一の単価解決クエリ
  //     (jan→products→distributor_products→hospital_prices, MIN(purchase_price))を使うため、
  //     共通のSQL関数resolve_jan_unit_priceに切り出して重複を排除する。
  //     consumable側はconsumables経由の別経路のため、同関数を呼び出しつつ最終的なjan解決だけ
  //     独自に行う（呼び出し1回として数える）。
  it('共通ヘルパー関数resolve_jan_unit_priceに単価解決ロジックを集約し、重複実装しない', () => {
    expect(n).toContain('create or replace function resolve_jan_unit_price(')
    // MIN(purchase_price)による単価解決の実クエリは resolve_jan_unit_price 内の1箇所のみに
    // 存在すること（case/loan/consumableそれぞれに同じクエリをインラインで重複実装しない）。
    const definitionOccurrences = n.match(/select min\(hp\.purchase_price\)/g) ?? []
    expect(definitionOccurrences.length).toBe(1)
    // case/loan/consumableの3箇所それぞれが実際にresolve_jan_unit_price(...)を呼び出すこと。
    expect(n).toContain("resolve_jan_unit_price(elem->>'jan', p_facility_id)")
    expect(n).toContain('resolve_jan_unit_price(c.jan, p_facility_id)')
  })

  it('case_order_items/loan_order_items/consumable_order_itemsのINSERT文にunit_price列を含む', () => {
    expect(n).toContain('insert into case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price)')
    expect(n).toContain('insert into loan_order_items (loan_order_id, jan, name, quantity, unit_price)')
    expect(n).toContain(
      'insert into consumable_order_items (consumable_order_id, consumable_id, quantity, unit_price)'
    )
  })

  it('単価解決に失敗してもRAISE EXCEPTIONせずNULLのまま挿入する(best-effort、例外はforbiddenメッセージのみ)', () => {
    const raiseCount = (n.match(/raise exception/g) ?? []).length
    expect(raiseCount).toBe(3)
    expect(n).toContain("raise exception 'forbidden: not a member of this facility'")
    expect(n).not.toMatch(/raise exception.{0,120}unit_price/i)
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
