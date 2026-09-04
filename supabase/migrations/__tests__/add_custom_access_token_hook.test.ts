import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無い実行環境でも回帰を検知できるよう、生成したSQL
//      マイグレーションの中身を静的に検証する。実DB上の動作確認は別途
//      統合テスト(custom-access-token-hook.integration.test.ts)で行う。
//      このテストは特にSECURITY DEFINERとCOALESCEの2点を固定する
//      (実機検証で判明した回帰しやすいポイント。docs/agents参照)。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_custom_access_token_hook.sql'))
    .sort()
    .at(-1)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-022 user_role クレーム
describe('*_add_custom_access_token_hook.sql [P-022]', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('custom_access_token_hook関数を定義する', () => {
    expect(n).toContain('create or replace function public.custom_access_token_hook(event jsonb)')
  })

  it('SECURITY DEFINERである(supabase_auth_adminはuser_facilitiesのRLS対象外のため必須)', () => {
    expect(n).toContain('security definer')
  })

  it('to_jsonb(v_role)をCOALESCEでJSON null化してからjsonb_setに渡す(STRICT関数のNULL伝播対策)', () => {
    expect(n).toContain("coalesce(to_jsonb(v_role), 'null'::jsonb)")
  })

  it('role集約ロジックがadmin > staff > viewerの優先順位で判定する', () => {
    expect(n).toContain("when bool_or(role = 'admin') then 'admin'")
    expect(n).toContain("when bool_or(role = 'staff') then 'staff'")
    expect(n).toContain("when bool_or(role = 'viewer') then 'viewer'")
  })

  it('supabase_auth_adminにのみEXECUTE権限を付与し、authenticated/anon/PUBLICからは剥奪する', () => {
    expect(n).toContain('grant execute on function public.custom_access_token_hook to supabase_auth_admin')
    expect(n).toContain('revoke execute on function public.custom_access_token_hook from authenticated, anon, public')
  })

  it('publicスキーマのテーブル追加/削除を伴わないため refresh_schema_baseline_snapshot を呼び出さない', () => {
    expect(n).not.toMatch(/select\s+refresh_schema_baseline_snapshot\(/)
  })
})
