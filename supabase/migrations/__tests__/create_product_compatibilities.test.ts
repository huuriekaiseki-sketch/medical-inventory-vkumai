import { readFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: ローカルSupabase(docker)が本環境に無いため実DB適用(supabase db reset)は出来ない。
//      代わりに生成したSQLマイグレーションの中身が仕様(SPEC.md Part2 Set A)を
//      満たすかを静的に検証することで、回帰テストとして固定する。
//      (supabase/migrations/__tests__/orders_history_prereqs.test.ts と同じ方針)

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').toLowerCase()
}

function findMigrationFile(): string | undefined {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('_create_product_compatibilities.sql'))
    .sort()
    .at(-1)
}

describe('*_create_product_compatibilities.sql', () => {
  const fileName = findMigrationFile()

  it('ファイルが存在する', () => {
    expect(fileName).toBeDefined()
  })

  const filePath = fileName ? path.join(MIGRATIONS_DIR, fileName) : ''
  const sql = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  const n = normalize(sql)

  it('product_compatibilities テーブルを作成する', () => {
    expect(n).toContain('create table product_compatibilities')
  })

  it('category_id / product_id_1 / product_id_2 の FK 制約 (ON DELETE CASCADE) を持つ', () => {
    expect(n).toContain('category_id uuid not null references categories(id) on delete cascade')
    expect(n).toContain('product_id_1 uuid not null references products(id) on delete cascade')
    expect(n).toContain('product_id_2 uuid not null references products(id) on delete cascade')
  })

  it('自己参照禁止のCHECK制約 (product_id_1 <> product_id_2) を持つ', () => {
    expect(n).toMatch(/check\s*\(product_id_1\s*<>\s*product_id_2\)/)
  })

  it('順序正規化のCHECK制約 (product_id_1 < product_id_2) を持つ', () => {
    expect(n).toMatch(/check\s*\(product_id_1\s*<\s*product_id_2\)/)
  })

  it('(category_id, product_id_1, product_id_2) の UNIQUE 制約を持つ', () => {
    expect(n).toMatch(/unique\s*\(category_id,\s*product_id_1,\s*product_id_2\)/)
  })

  const expectedIndexes = [
    'create index idx_compat_category_id on product_compatibilities (category_id)',
    'create index idx_compat_product_id_1 on product_compatibilities (product_id_1)',
    'create index idx_compat_product_id_2 on product_compatibilities (product_id_2)',
  ]

  it.each(expectedIndexes)('%s を含む', (stmt) => {
    expect(n).toContain(stmt)
  })

  it('updated_at自動更新トリガーを持つ（他マスタと同型）', () => {
    expect(n).toMatch(
      /create trigger product_compatibilities_updated_at before update on product_compatibilities for each row execute procedure update_updated_at\(\)/,
    )
  })

  it('anon/authenticated/service_roleへのGRANTを持つ（他マスタと同型。RLSのみでは不十分でGRANTも必要）', () => {
    expect(n).toMatch(
      /grant all on table public\.product_compatibilities to postgres, anon, authenticated, service_role/,
    )
  })

  it('RLSを有効化する', () => {
    expect(n).toContain('alter table product_compatibilities enable row level security')
  })

  it('SELECTは全認証ユーザーに許可するポリシーを持つ', () => {
    expect(n).toMatch(
      /create policy "?compat_select"? on product_compatibilities for select to authenticated using \(true\)/,
    )
  })

  it('書き込み(INSERT/DELETE/UPDATE)はis_admin()のみのポリシーを持つ', () => {
    expect(n).toMatch(
      /create policy "?compat_write"? on product_compatibilities for all to authenticated using \(is_admin\(\)\) with check \(is_admin\(\)\)/,
    )
  })

  it('publicスキーマにテーブルを新設するため refresh_schema_baseline_snapshot を呼び出す(issue #305要件)', () => {
    expect(n).toMatch(/select\s+refresh_schema_baseline_snapshot\('[^']+'\)/)
  })

  it('refresh_schema_baseline_snapshotに渡すepochがこのmigrationファイル自身のタイムスタンプと一致する', () => {
    const match = fileName?.match(/^(\d+)_create_product_compatibilities\.sql$/)
    const timestamp = match?.[1]
    expect(timestamp).toBeDefined()
    expect(n).toContain(`select refresh_schema_baseline_snapshot('${timestamp}')`)
  })
})
