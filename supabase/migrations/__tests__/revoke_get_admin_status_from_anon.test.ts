import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: 20260827000001 は REVOKE ... FROM PUBLIC → GRANT TO authenticated, service_role で
//      「anon を含めない」つもりだったが、Supabase の ALTER DEFAULT PRIVILEGES が CREATE 時に anon へ
//      明示 EXECUTE を付けるため、素の DB では anon が呼べた（P-045 を CI で回して発見）。
//      是正 migration の内容を静的に固定する。実 DB で anon が 42501 になることは
//      rpc-boundary.integration.test.ts（P-045）が確かめる。

const FILE = path.join(path.resolve(__dirname, '..'), '20260906000002_revoke_get_admin_status_from_anon.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-045 認可述語・読み取り RPC は anon で拒否される
describe('20260906000002_revoke_get_admin_status_from_anon.sql [P-045]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

  it('get_admin_status() の EXECUTE を anon から明示的に外す', () => {
    expect(n).toContain('revoke execute on function get_admin_status() from anon;')
  })

  it('authenticated / service_role の権限には触れない（REVOKE ALL や GRANT を書かない）', () => {
    expect(n).not.toMatch(/revoke all/)
    expect(n).not.toMatch(/grant /)
  })
})
