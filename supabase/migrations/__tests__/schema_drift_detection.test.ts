import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseへの実DB適用確認とは別に、生成したSQLマイグレーションの中身が
//      仕様(SPEC.md issue #305 Part2 セット1・セット2)を満たすかを静的に検証することで、
//      回帰テストとして固定する（既存 tech_debt_migrations.test.ts と同じ静的SQL検証方式）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const DRIFT_DETECTION_FILE = path.join(
  MIGRATIONS_DIR,
  '20260714000001_create_schema_drift_detection.sql'
)
const CRON_SCHEDULE_FILE = path.join(
  MIGRATIONS_DIR,
  '20260714000002_schedule_schema_drift_check.sql'
)

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260714000001_create_schema_drift_detection.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(DRIFT_DETECTION_FILE)).toBe(true)
  })

  const sql = existsSync(DRIFT_DETECTION_FILE) ? readFileSync(DRIFT_DETECTION_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('schema_baseline_snapshots テーブルを作成し RLS を有効化する', () => {
    expect(n).toContain('create table schema_baseline_snapshots')
    expect(n).toContain('alter table schema_baseline_snapshots enable row level security')
  })

  it('schema_drift_log テーブルを作成し event_kind に CHECK 制約を持つ', () => {
    expect(n).toContain('create table schema_drift_log')
    expect(n).toContain("check (event_kind in ('detected','acknowledged','resolved')")
    expect(n).toContain('alter table schema_drift_log enable row level security')
  })

  it('schema_drift_log_open_unique が resolved_at is null の部分ユニークインデックスである（冪等性の担保）', () => {
    expect(n).toContain('create unique index schema_drift_log_open_unique')
    expect(n).toContain('on schema_drift_log (drift_type, object_name) where resolved_at is null')
  })

  it('初期snapshotを pg_tables の実データから導出する（手動列挙をしない）', () => {
    expect(n).toContain('insert into schema_baseline_snapshots (epoch, snapshot)')
    expect(n).toContain("select '20260714000001', jsonb_agg(tablename order by tablename)")
    expect(n).toContain("from pg_tables where schemaname = 'public'")
  })

  it('check_schema_drift() を定義する（SECURITY DEFINER）', () => {
    expect(n).toContain('create or replace function check_schema_drift()')
    expect(n).toContain('returns table (drift_type text, object_name text, detail jsonb)')
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
  })

  it('check_schema_drift() は基盤テーブル消失時に例外を送出する自己参照ガードを持つ', () => {
    expect(n).toContain("to_regclass('public.schema_drift_log') is null")
    expect(n).toContain("to_regclass('public.schema_baseline_snapshots') is null")
    expect(n).toContain('raise exception')
  })

  it('check_schema_drift() は rls_disabled / table_added / table_removed の3種を検知する', () => {
    expect(n).toContain("select 'rls_disabled'")
    expect(n).toContain('c.relrowsecurity = false')
    expect(n).toContain("select 'table_added'")
    expect(n).toContain('not (latest_snapshot ? t.tablename)')
    expect(n).toContain("select 'table_removed'")
    expect(n).toContain('jsonb_array_elements_text(latest_snapshot)')
  })

  it('check_schema_drift() の実行権限は service_role のみに限定される', () => {
    expect(n).toContain('grant execute on function check_schema_drift')
    expect(n).toContain('to service_role')
    // 過剰付与を防ぐ: authenticated/anon への EXECUTE 付与を含まないこと
    expect(n).not.toMatch(/grant execute on function check_schema_drift[^;]*to (authenticated|anon)/)
  })

  it('record_schema_drift() を定義し、冪等insertと自動resolvedを行う', () => {
    expect(n).toContain('create or replace function record_schema_drift()')
    expect(n).toContain('insert into schema_drift_log (drift_type, object_name, detail)')
    expect(n).toContain('on conflict (drift_type, object_name) where resolved_at is null do nothing')
    expect(n).toContain("set event_kind = 'resolved', resolved_at = now()")
    expect(n).toContain('grant execute on function record_schema_drift')
    expect(n).toContain('to service_role')
  })

  it('drift_alert_view を定義し、未解決分のみ・detail列を含まない形でanonに公開する', () => {
    expect(n).toContain('create view drift_alert_view as')
    expect(n).toContain('select id, drift_type, object_name, detected_at, issue_url')
    expect(n).toContain("where event_kind = 'detected' and resolved_at is null")
    expect(n).not.toMatch(/create view drift_alert_view as select[^;]*detail/)
    expect(n).toContain('grant select on drift_alert_view to anon')
    // SELECT以外の権限を anon に付与していないこと（過剰付与防止）
    expect(n).not.toMatch(/grant (all|insert|update|delete)[^;]*drift_alert_view[^;]*to anon/)
  })

  it('record_issue_url(log_id uuid, url text) を定義し、GitHub Actionsからのissue_url書き戻しをservice_roleのみに限定する', () => {
    expect(n).toContain('create or replace function record_issue_url(log_id uuid, url text)')
    expect(n).toContain('update schema_drift_log set issue_url = url where id = log_id')
    expect(n).toContain('grant execute on function record_issue_url')
    expect(n).toContain('to service_role')
  })
})

describe('20260714000002_schedule_schema_drift_check.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(CRON_SCHEDULE_FILE)).toBe(true)
  })

  const sql = existsSync(CRON_SCHEDULE_FILE) ? readFileSync(CRON_SCHEDULE_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('pg_cron拡張を有効化する', () => {
    expect(n).toContain('create extension if not exists pg_cron')
  })

  it('schema-drift-daily-check ジョブを毎日record_schema_drift()を呼ぶよう登録する', () => {
    expect(n).toContain("cron.schedule( 'schema-drift-daily-check'")
    expect(n).toContain("'0 23 * * *'")
    expect(n).toContain('select record_schema_drift();')
  })
})
