import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: PR #760 の RPC 公開判定（P-043）の初回計測で、schema drift 系 4 関数が
//      「service_role のみ」の注記に反して PostgreSQL 既定の PUBLIC 権限で anon から呼べていた。
//      是正 migration の内容を静的に固定する（実 DB で anon / authenticated が拒否されることは
//      supabase/__tests__/integration/schema-drift-rpc-authz.integration.test.ts が確かめる）。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const FILE = path.join(MIGRATIONS_DIR, '20260906000001_revoke_schema_drift_rpcs_from_client_roles.sql')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

const FUNCTIONS = [
  'check_schema_drift()',
  'record_schema_drift()',
  'record_issue_url(uuid, text)',
  'refresh_schema_baseline_snapshot(text)',
]

// 約束カタログ（docs/agents/promise-catalog.md）: P-044 schema drift 系 RPC は service_role 以外から呼べない
describe('20260906000001_revoke_schema_drift_rpcs_from_client_roles.sql [P-044]', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  const n = existsSync(FILE) ? normalize(readFileSync(FILE, 'utf-8')) : ''

  it.each(FUNCTIONS)('%s の EXECUTE を PUBLIC / anon / authenticated から外す', (fn) => {
    expect(n).toContain(`revoke all on function ${fn} from public, anon, authenticated;`)
  })

  it.each(FUNCTIONS)('%s の EXECUTE を service_role に残す', (fn) => {
    expect(n).toContain(`grant execute on function ${fn} to service_role;`)
  })

  it('REVOKE が GRANT より先に書かれている（GRANT → REVOKE ALL の順だと service_role も失う）', () => {
    for (const fn of FUNCTIONS) {
      const revokeIdx = n.indexOf(`revoke all on function ${fn}`)
      const grantIdx = n.indexOf(`grant execute on function ${fn} to service_role`)
      expect(revokeIdx, fn).toBeGreaterThanOrEqual(0)
      expect(grantIdx, fn).toBeGreaterThan(revokeIdx)
    }
  })

  it('client ロールへの GRANT を新たに書いていない', () => {
    expect(n).not.toMatch(/grant [^;]*on function [^;]* to [^;]*\b(anon|authenticated|public)\b/)
  })
})
