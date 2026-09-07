import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 24・39（P-066）。特権操作の記録表が「client に書けない・admin だけが読める・
//      消せない」形から外れていないことを静的に固定する（実 DB は
//      privileged-operations-rls-idor.integration.test.ts）。
//      access_denials（P-063）と同じ型だが、こちらは**メールを持つ**ぶん読み手の制限が効いている
//      ことがより重要になる。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_privileged_operations.sql'))
    .sort()
    .at(-1)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-066 特権操作（Auth 管理 API）の記録
describe('privileged_operations は append-only で aal2 の admin だけが読める [P-066]', () => {
  const file = findMigrationFile()

  it('migration ファイルが存在する', () => {
    expect(file).toBeDefined()
  })

  const raw = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : ''
  const sql = normalize(raw)

  it('RLS を有効にし、SELECT は admin かつ aal2 に限る（メールを含むため）', () => {
    expect(sql).toContain('alter table privileged_operations enable row level security')
    expect(sql).toContain(
      'create policy privileged_operations_select on privileged_operations for select to authenticated using (is_admin() and has_aal2())',
    )
  })

  it('書き込み系のポリシーを作らない（client は INSERT / UPDATE / DELETE できない）', () => {
    for (const op of ['for insert', 'for update', 'for delete', 'for all']) {
      expect(sql).not.toContain(`on privileged_operations ${op}`)
    }
  })

  it('Supabase の既定権限を 4 ロールとも REVOKE し、SELECT だけを渡す', () => {
    // WHY: E-032（rate_limit_counters）で「anon / authenticated しか REVOKE しておらず
    //      PUBLIC と service_role が ALL を持ったまま」だった実害がある。既定に答えを委ねない
    expect(sql).toContain(
      'revoke all on table privileged_operations from public, anon, authenticated, service_role',
    )
    expect(sql).toContain('grant select on table privileged_operations to authenticated, service_role')
  })

  it('記録は SECURITY DEFINER の RPC 経由で、EXECUTE は service_role だけに渡す', () => {
    expect(sql).toContain('create or replace function record_privileged_operation')
    expect(sql).toContain('security definer')
    expect(sql).toContain("set search_path = ''")
    expect(sql).toContain('revoke all on function record_privileged_operation')
    expect(sql).toMatch(/grant execute on function record_privileged_operation[^;]*to service_role/)
    // anon / authenticated へ EXECUTE を渡さない（渡すと誰でも偽の記録を作れる）
    expect(sql).not.toMatch(/grant execute on function record_privileged_operation[^;]*to (anon|authenticated)/)
  })

  it('成功も失敗も残す（succeeded 列がある）', () => {
    // WHY: 失敗だけ残すと「試したが通らなかった」しか見えず、乗っ取り後に**通った**操作の
    //      範囲が分からない
    expect(sql).toContain('succeeded boolean not null')
  })

  it('operation の語彙を CHECK で固定する（自由文字列にしない）', () => {
    expect(sql).toContain("check (operation in ('user_invite', 'user_delete'))")
  })

  it('route はクエリ文字列を落として保存する（施設 ID や検索語を証跡に残さない）', () => {
    expect(sql).toContain("split_part(coalesce(p_route, ''), '?', 1)")
  })

  it('UPDATE / DELETE / TRUNCATE をトリガーで拒否する（service_role でも消せない）', () => {
    expect(sql).toContain('before update or delete on privileged_operations')
    expect(sql).toContain('before truncate on privileged_operations')
    expect(sql).toContain('insufficient_privilege')
  })

  it('actor_id / target_user_id に FK を張らない（利用者が消えても証跡を残す）', () => {
    expect(sql).not.toMatch(/actor_id\s+uuid[^,]*references/)
    expect(sql).not.toMatch(/target_user_id\s+uuid[^,]*references/)
  })

  it('自由入力の列に長さの上限がある（I-06x と同じ扱い）', () => {
    expect(sql).toContain('length(target_email) <= 254')
    expect(sql).toContain('length(route) <= 200')
  })

  it('テーブル追加なので baseline スナップショットを更新する', () => {
    expect(sql).toContain("select refresh_schema_baseline_snapshot('20260907050000')")
  })

  it('リリース順序とロールバック手順が書いてある', () => {
    expect(raw).toContain('release-order:')
    expect(raw).toContain('ROLLBACK:')
  })

  it('人が決めた設計判断（PII を残す判断を含む）が書いてある', () => {
    // WHY: メールを残すのは 2026-09-07 に人が決めたこと。AI が勝手に決めた形にしない
    expect(raw).toContain('design:')
    expect(raw).toContain('人へ聞いて決めた答え')
  })
})
