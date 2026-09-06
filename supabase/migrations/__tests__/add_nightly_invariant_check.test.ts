import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 9。夜間検査の骨格（drift_type の拡張、検知関数の 2 軸、記録関数の冪等性と
//      種別限定の resolved、権限、pg_cron）を静的に固定する。検知が本当に違反を拾うことは
//      supabase/__tests__/integration/business-invariants-nightly.integration.test.ts が実 DB で確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000005_add_nightly_invariant_check.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-050 返却 ≤ 貸出 / I-051 NOT VALID の既存行違反 0
describe('20260906000005_add_nightly_invariant_check.sql [I-050 I-051]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('drift_type の CHECK に invariant_violation を足す（既存 3 値は残す）', () => {
    expect(n).toContain("check (drift_type in ('rls_disabled', 'table_added', 'table_removed', 'invariant_violation'))")
  })

  it('check_business_invariants は I-050（JAN ごとの返却 > 貸出）と I-051（NOT VALID 制約の違反行数）を返す', () => {
    expect(n).toContain('create or replace function check_business_invariants() returns table (invariant_id text, object_name text, detail jsonb)')
    expect(n).toContain("select 'i-050'::text")
    expect(n).toContain('where rt.qty > coalesce(ln.qty, 0)')
    expect(n).toContain("where c.contype = 'c' and not c.convalidated and n.nspname = 'public'")
    expect(n).toContain("invariant_id := 'i-051'")
  })

  it('record_business_invariants は冪等 INSERT し、resolved は invariant_violation に限定する', () => {
    expect(n).toContain("select 'invariant_violation', i.object_name, i.detail from _current_invariants i on conflict (drift_type, object_name) where resolved_at is null do nothing")
    expect(n).toContain("where l.drift_type = 'invariant_violation' and l.event_kind = 'detected' and l.resolved_at is null")
  })

  it('record_schema_drift の resolved も自分の 3 種別に限定し直す（invariant 行を巻き添えにしない）', () => {
    expect(n).toContain("where l.drift_type in ('rls_disabled', 'table_added', 'table_removed') and l.event_kind = 'detected' and l.resolved_at is null")
  })

  it('2 関数とも client ロールから REVOKE し、service_role だけに GRANT する', () => {
    for (const fn of ['check_business_invariants()', 'record_business_invariants()']) {
      expect(n).toContain(`revoke all on function ${fn} from public, anon, authenticated;`)
      expect(n).toContain(`grant execute on function ${fn} to service_role;`)
    }
  })

  it('pg_cron に日次ジョブを登録する（schema drift より前）', () => {
    expect(n).toContain("cron.schedule( 'business-invariants-daily-check', '50 22 * * *'")
    expect(n).toContain('select record_business_invariants();')
  })
})
