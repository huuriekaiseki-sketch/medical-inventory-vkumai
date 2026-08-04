import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無い実行環境でも回帰を検知できるよう、生成したSQL
//      マイグレーションの中身を静的に検証する。実DB上の動作確認は別途
//      ローカルSupabaseへのdb push + RPC呼び出しで行う（このテストの対象外）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_harden_order_rpc_search_path.sql'))
    .sort()
    .at(-1)
}

describe('*_harden_order_rpc_search_path.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('既存migrationを追記せず、CREATE OR REPLACE FUNCTIONで4つのRPC/ヘルパーを再定義する', () => {
    expect(n).toContain('create or replace function resolve_jan_unit_price(')
    expect(n).toContain('create or replace function create_case_order_atomic(')
    expect(n).toContain('create or replace function create_loan_order_atomic(')
    expect(n).toContain('create or replace function create_consumable_order_atomic(')
  })

  it('4関数すべてがsearch_pathを空文字に固定している（search_path hijacking対策）', () => {
    const occurrences = n.match(/set search_path = ''/g) ?? []
    expect(occurrences.length).toBe(4)
    // 旧来の SET search_path = public は残っていないこと
    expect(n).not.toContain('set search_path = public')
  })

  it('is_facility_memberチェックを維持している（施設境界チェックの退行防止）', () => {
    const occurrences = n.match(/if not public\.is_facility_member\(p_facility_id\) then/g) ?? []
    expect(occurrences.length).toBe(3)
  })

  it('resolve_jan_unit_price内の全テーブル参照がpublic.で完全修飾されている', () => {
    expect(n).toContain('from public.products p')
    expect(n).toContain('join public.distributor_products dp on dp.product_id = p.id')
    expect(n).toContain('join public.hospital_prices hp')
  })

  it('%ROWTYPE宣言がpublic.で完全修飾されている', () => {
    expect(n).toContain('v_order public.case_orders%rowtype')
    expect(n).toContain('v_order public.loan_orders%rowtype')
    expect(n).toContain('v_order public.consumable_orders%rowtype')
  })

  it('INSERT/SELECT先のテーブルがpublic.で完全修飾されている', () => {
    expect(n).toContain('insert into public.case_orders (')
    expect(n).toContain('insert into public.case_order_items (case_order_id, jan, lot, ubd, quantity, unit_price)')
    expect(n).toContain('from public.case_order_items i')
    expect(n).toContain('insert into public.loan_orders (facility_id, procedure_name, maker)')
    expect(n).toContain('insert into public.loan_order_items (loan_order_id, jan, name, quantity, unit_price)')
    expect(n).toContain('from public.loan_order_items i')
    expect(n).toContain('insert into public.consumable_orders (facility_id)')
    expect(n).toContain(
      'insert into public.consumable_order_items (consumable_order_id, consumable_id, quantity, unit_price)'
    )
    expect(n).toContain('from public.consumable_order_items i')
    expect(n).toContain('from public.consumables c')
  })

  it('resolve_jan_unit_price呼び出しがpublic.で完全修飾されている', () => {
    const occurrences = n.match(/public\.resolve_jan_unit_price\(/g) ?? []
    expect(occurrences.length).toBe(3)
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
