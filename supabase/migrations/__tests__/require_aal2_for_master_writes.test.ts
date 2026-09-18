import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: issue #757 の 39。マスタ 4 表と施設作成の書き込みポリシーが has_aal2() を落とさないことを
//      静的に固定する（実 DB での挙動は blast-radius.integration.test.ts が測る）。
//      ポリシーは後の migration で上書きされうるので、「最後に定義した migration」ではなく
//      この migration の中身だけを見る。実 DB 側の退行は統合テストが受け持つ。

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_require_aal2_for_master_writes.sql'))
    .sort()
    .at(-1)
}

const MASTER_POLICIES: [string, string][] = [
  ['products_write', 'products'],
  ['categories_write', 'categories'],
  ['distributor_products_write', 'distributor_products'],
  ['compat_write', 'product_compatibilities'],
]

// 約束カタログ（docs/agents/promise-catalog.md）: P-033 マスタの書き込みにも aal2
describe('マスタの書き込みポリシーは is_admin() に加えて has_aal2() を要求する [P-033]', () => {
  const file = findMigrationFile()

  it('migration ファイルが存在する', () => {
    expect(file).toBeDefined()
  })

  const sql = file ? normalize(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')) : ''

  it.each(MASTER_POLICIES)('%s は USING / WITH CHECK の両方で is_admin() and has_aal2() になっている', (policy, table) => {
    expect(sql).toContain(
      `create policy "${policy}" on ${table} for all to authenticated using (is_admin() and has_aal2()) with check (is_admin() and has_aal2())`
    )
  })

  it('facilities の新規作成（admin_insert）も aal2 を要求する', () => {
    expect(sql).toContain(
      'create policy "admin_insert" on facilities for insert to authenticated with check (is_admin() and has_aal2())'
    )
  })

  it('facilities の更新（施設名）は #623 の判断どおり aal2 の対象外のまま（この migration が触らない）', () => {
    expect(sql).not.toContain('facility_writer_or_admin_update')
  })

  it('置き換える前に古いポリシーを DROP する（重複定義で許可が広い方が残らない）', () => {
    for (const [policy, table] of MASTER_POLICIES) {
      expect(sql).toContain(`drop policy if exists "${policy}" on ${table}`)
    }
    expect(sql).toContain('drop policy if exists "admin_insert" on facilities')
  })

  it('リリース順序とロールバック手順が書いてある', () => {
    const raw = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : ''
    expect(raw).toContain('-- release-order: db-first')
    expect(raw).toContain('-- ROLLBACK:')
  })
})
