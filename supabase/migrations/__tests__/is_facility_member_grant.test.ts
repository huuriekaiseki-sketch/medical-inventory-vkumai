import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 セット4)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      is_facility_member() は PostgreSQL のデフォルト仕様で PUBLIC に EXECUTE
//      権限が暗黙付与されているが、他のRPC関数（create_loan_order_atomic 等）と
//      同様に明示的な GRANT を行うことで、将来 REVOKE EXECUTE FROM PUBLIC の
//      ような防御的変更が入った際に静かに壊れることを防ぐ。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findGrantMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .find((f) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')
      return normalize(sql).includes('grant execute on function is_facility_member')
    })
}

describe('is_facility_member への GRANT EXECUTE 明示化', () => {
  const file = findGrantMigrationFile()

  it('is_facility_member に GRANT EXECUTE するマイグレーションが存在する', () => {
    expect(file).toBeDefined()
  })

  it('authenticated ロールに EXECUTE 権限を付与する', () => {
    expect(file).toBeDefined()
    const sql = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') : ''
    const n = normalize(sql)
    expect(n).toContain('grant execute on function is_facility_member')
    expect(n).toContain('to authenticated')
  })

  it('ファイルが存在する場合、拡張子が .sql であること', () => {
    if (file) {
      expect(existsSync(path.join(MIGRATIONS_DIR, file))).toBe(true)
    }
  })
})
