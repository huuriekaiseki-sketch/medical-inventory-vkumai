import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 24（P-063）。拒否の記録表が「client に書けない・admin だけが読める・
//      消せない」形から外れていないことを静的に固定する（実 DB は access-denials.integration.test.ts）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_access_denials.sql'))
    .sort()
    .at(-1)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-063 拒否された操作の記録
describe('access_denials は append-only で admin だけが読める [P-063]', () => {
  const file = findMigrationFile()

  it('migration ファイルが存在する', () => {
    expect(file).toBeDefined()
  })

  const raw = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : ''
  const sql = normalize(raw)

  it('RLS を有効にし、SELECT は admin かつ aal2 に限る', () => {
    expect(sql).toContain('alter table access_denials enable row level security')
    expect(sql).toContain(
      'create policy access_denials_select on access_denials for select to authenticated using (is_admin() and has_aal2())'
    )
  })

  it('書き込み系のポリシーを作らない（client は INSERT / UPDATE / DELETE できない）', () => {
    expect(sql).not.toContain('on access_denials for insert')
    expect(sql).not.toContain('on access_denials for update')
    expect(sql).not.toContain('on access_denials for delete')
    expect(sql).not.toContain('on access_denials for all')
  })

  it('Supabase の既定権限を 3 ロールとも REVOKE し、SELECT だけを渡す', () => {
    expect(sql).toContain('revoke all on table access_denials from public, anon, authenticated, service_role')
    expect(sql).toContain('grant select on table access_denials to authenticated, service_role')
  })

  it('記録は SECURITY DEFINER の RPC 経由で、EXECUTE は service_role だけに渡す', () => {
    expect(sql).toContain('create or replace function record_access_denial(')
    expect(sql).toContain('security definer set search_path = \'\'')
    expect(sql).toContain(
      'revoke all on function record_access_denial(text, text, text, text, uuid, uuid) from public, anon, authenticated'
    )
    expect(sql).toContain(
      'grant execute on function record_access_denial(text, text, text, text, uuid, uuid) to service_role'
    )
  })

  it('route はクエリ文字列を落として保存する（施設 ID や検索語を証跡に残さない）', () => {
    expect(sql).toContain("split_part(coalesce(p_route, ''), '?', 1)")
  })

  it('UPDATE / DELETE / TRUNCATE をトリガーで拒否する（service_role でも消せない）', () => {
    expect(sql).toContain('before update or delete on access_denials')
    expect(sql).toContain('before truncate on access_denials')
    expect(sql).toContain('insufficient_privilege')
  })

  it('guard / reason の語彙を CHECK で固定する', () => {
    expect(sql).toContain("check (guard in ('auth', 'facility', 'admin', 'proxy_admin'))")
    expect(sql).toContain(
      "check (reason in ('unauthenticated', 'facility_id_required', 'forbidden', 'not_admin'))"
    )
  })

  it('actor_id / facility_id に FK を張らない（利用者や施設が消えても証跡を残す）', () => {
    expect(sql).not.toContain('actor_id uuid references')
    expect(sql).not.toContain('facility_id uuid references')
  })

  it('テーブル追加なので baseline スナップショットを更新する', () => {
    expect(sql).toContain("select refresh_schema_baseline_snapshot('20260907000002')")
  })

  it('リリース順序とロールバック手順が書いてある', () => {
    expect(raw).toContain('-- release-order: db-first')
    expect(raw).toContain('-- ROLLBACK:')
  })
})
