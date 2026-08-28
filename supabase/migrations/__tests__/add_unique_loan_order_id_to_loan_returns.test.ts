import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabaseが無いため実DB適用は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(issue #675)を満たすかを静的に検証することで、
//      回帰テストとして固定する(add_loan_order_id_to_loan_return_atomic_rpc.test.tsと同じ静的検証パターン)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_add_unique_loan_order_id_to_loan_returns.sql'))
    .sort()
    .at(-1)
}

describe('*_add_unique_loan_order_id_to_loan_returns.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('loan_returns.loan_order_idにUNIQUEインデックスを作成する', () => {
    expect(n).toContain('create unique index loan_returns_loan_order_id_unique')
    expect(n).toContain('on loan_returns (loan_order_id)')
  })

  it('NULLを除外した部分インデックスである(対象を選ばない返却は制約対象外)', () => {
    expect(n).toContain('where loan_order_id is not null')
  })
})
