import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(Issue #24 Set1)を
//      満たすかを静的に検証することで、回帰テストとして固定する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const RPC_FILE = path.join(MIGRATIONS_DIR, '20260704000001_add_admin_status_rpc.sql')
const RESTRICT_FILE = path.join(MIGRATIONS_DIR, '20260704000002_restrict_admin_status_rpc.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260704000001_add_admin_status_rpc.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(RPC_FILE)).toBe(true)
  })

  const sql = existsSync(RPC_FILE) ? readFileSync(RPC_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('get_admin_status(p_user_id uuid) を定義する', () => {
    expect(n).toContain('create or replace function get_admin_status(')
    expect(n).toContain('p_user_id uuid')
    expect(n).toContain('returns table (user_is_admin boolean, db_has_admin boolean)')
  })

  it('SECURITY DEFINER / search_path=public で定義する', () => {
    expect(n).toContain('security definer')
    expect(n).toContain('set search_path = public')
  })

  it('anon, authenticated, service_role に EXECUTE を許可する', () => {
    expect(n).toContain('grant execute on function get_admin_status to anon, authenticated, service_role')
  })
})

describe('20260704000002_restrict_admin_status_rpc.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(RESTRICT_FILE)).toBe(true)
  })

  const sql = existsSync(RESTRICT_FILE) ? readFileSync(RESTRICT_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('anon からEXECUTE権限を取り消す（resolveIsAdminは認証済みユーザーのみが呼ぶため過剰権限だった）', () => {
    expect(n).toContain('revoke execute on function get_admin_status from anon')
  })
})
