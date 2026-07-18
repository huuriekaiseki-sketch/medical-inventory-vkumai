import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #461の回帰テスト。product_compatibilitiesテーブルへのanon向けGRANT ALLが
// 他マスタテーブル（REVOKE ALL FROM anon済み）との一貫性を欠いていた問題を修正した
// マイグレーションの内容を静的に固定する。ローカルSupabaseでの実機検証
// （anon keyでSELECT/INSERTを試み、GRANTレベルでpermission denied(42501)になることを確認、
// PASS済み）は別途手動で実施済みだが、CI環境では実DB接続が無いため、admin_rls.test.ts等と
// 同じパターンでマイグレーションファイルの内容を静的に検証する。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')
const REVOKE_FILE = path.join(MIGRATIONS_DIR, '20260718000002_revoke_product_compatibilities_anon.sql')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

describe('20260718000002_revoke_product_compatibilities_anon.sql', () => {
  it('ファイルが存在する', () => {
    expect(existsSync(REVOKE_FILE)).toBe(true)
  })

  const sql = existsSync(REVOKE_FILE) ? readFileSync(REVOKE_FILE, 'utf-8') : ''
  const n = normalize(sql)

  it('product_compatibilitiesからanonの権限をREVOKEする', () => {
    expect(n).toContain('revoke all on product_compatibilities from anon')
  })
})
