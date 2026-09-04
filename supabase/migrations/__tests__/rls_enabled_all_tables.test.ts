import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// WHY: RLS有効化の防御は現状2層ある:
//      1) 各migration個別の静的テスト（create_product_compatibilities.test.ts 等）
//      2) DB側のensure_rlsイベントトリガー（20260707000001）による新規テーブル自動有効化
//      しかし1)はテーブルごとにテストを書き忘れると素通りし、2)はトリガー自体が将来の
//      migrationで削除・失敗（RAISE LOGのみで握り潰し）しても気づけない。また、どちらも
//      「後続migrationでDISABLE ROW LEVEL SECURITYされる」ケースを検知しない。
//      そこで全migrationを時系列に走査し、最終的に存在する全テーブルについて
//      「明示的なENABLE ROW LEVEL SECURITYがある」「DISABLEが存在しない」
//      「ポリシーが最低1つある（意図的deny-allは許可リスト管理）」を横断検証する。
//      （docs/agents/decisions/db-rls.md「なぜRLS/IDORゲート（e2e.ymlのtest:integration）の
//      誤差許容率を『0%』と明文化したか」のセーフティネット強化。DB接続不要の静的解析のため
//      npm test＝CI / test jobで毎PR実行される）

const MIGRATIONS_DIR = path.resolve(__dirname, '..')

// RLSは有効だがCREATE POLICYを意図的に持たない（=deny-all、SECURITY DEFINER関数経由での
// み読み書きする）テーブル。新規追加時は理由をコメントで添えること。
const INTENTIONALLY_POLICYLESS_TABLES = new Set([
  // スキーマドリフト検知の内部テーブル（20260714000001）。record_schema_drift()等の
  // SECURITY DEFINER関数からのみ書き込まれ、クライアントロールへの直接公開はしない
  'schema_baseline_snapshots',
  'schema_drift_log',
])

/** SQLからコメント・$$本体・文字列リテラルを除去し、DDL文だけを走査可能にする */
function stripNonDdl(sql: string): string {
  return (
    sql
      // ドル引用符ブロック（関数本体等）。中のSQL風文字列をDDLと誤認しないよう丸ごと除去
      .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
      // 行コメント
      .replace(/--[^\n]*/g, ' ')
      // ブロックコメント
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // 文字列リテラル（イベントトリガー定義の 'CREATE TABLE AS' 等を除外するため）
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/\s+/g, ' ')
      .toLowerCase()
  )
}

/** "public.foo" / "foo" / public.foo / foo → foo に正規化 */
function normalizeTableName(raw: string): string {
  return raw.replace(/"/g, '').replace(/^public\./, '')
}

interface TableState {
  rlsEnabled: boolean
  policyCount: number
  createdIn: string
}

/** 全migrationをファイル名順（=適用順）に走査し、最終的なテーブル状態を組み立てる */
function scanMigrations(): Map<string, TableState> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const tables = new Map<string, TableState>()

  for (const file of files) {
    const sql = stripNonDdl(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))

    for (const statement of sql.split(';')) {
      const createMatch = statement.match(
        /create table (?:if not exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)(?:\s|\()/,
      )
      if (createMatch) {
        const name = normalizeTableName(createMatch[1])
        // 新規作成（再作成含む）直後はRLS無効・ポリシー0が素の状態
        tables.set(name, { rlsEnabled: false, policyCount: 0, createdIn: file })
        continue
      }

      const dropMatch = statement.match(
        /drop table (?:if exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/,
      )
      if (dropMatch) {
        tables.delete(normalizeTableName(dropMatch[1]))
        continue
      }

      const enableMatch = statement.match(
        /alter table (?:if exists )?(?:only )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?) enable row level security/,
      )
      if (enableMatch) {
        const state = tables.get(normalizeTableName(enableMatch[1]))
        if (state) state.rlsEnabled = true
        continue
      }

      const policyMatch = statement.match(
        /create policy "?[a-z0-9_]+"? on ((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/,
      )
      if (policyMatch) {
        const state = tables.get(normalizeTableName(policyMatch[1]))
        if (state) state.policyCount += 1
      }
    }
  }

  return tables
}

function filesContainingDisableRls(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      stripNonDdl(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')).includes(
        'disable row level security',
      ),
    )
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-040 全テーブル RLS 有効・DISABLE 無し・ポリシー最低 1 つ
describe('全テーブルRLS有効化の横断静的検査 [P-040]', () => {
  const tables = scanMigrations()

  it('migrationからテーブルを1つ以上検出できている（パーサ自壊の検知）', () => {
    // 走査ロジックの regex が壊れて全件素通りしたら、このテスト自体が先に落ちる
    expect(tables.size).toBeGreaterThanOrEqual(19)
  })

  it('最終的に存在する全テーブルに明示的なENABLE ROW LEVEL SECURITYがある', () => {
    const missing = [...tables.entries()]
      .filter(([, state]) => !state.rlsEnabled)
      .map(([name, state]) => `${name} (created in ${state.createdIn})`)
    // ensure_rlsイベントトリガーの自動有効化に暗黙依存せず、migrationに明示すること
    expect(missing).toEqual([])
  })

  it('DISABLE ROW LEVEL SECURITYがどのmigrationにも存在しない', () => {
    expect(filesContainingDisableRls()).toEqual([])
  })

  it('RLS有効の全テーブルにCREATE POLICYが最低1つある（意図的deny-allは許可リスト管理）', () => {
    const policyless = [...tables.entries()]
      .filter(
        ([name, state]) =>
          state.policyCount === 0 && !INTENTIONALLY_POLICYLESS_TABLES.has(name),
      )
      .map(([name, state]) => `${name} (created in ${state.createdIn})`)
    expect(policyless).toEqual([])
  })

  it('許可リストのテーブルは実在しポリシー0のままである（リスト陳腐化の検知）', () => {
    for (const name of INTENTIONALLY_POLICYLESS_TABLES) {
      const state = tables.get(name)
      expect(state, `${name} がmigrationに存在しない（許可リストから削除すること）`).toBeDefined()
      expect(
        state?.policyCount,
        `${name} にポリシーが追加された（許可リストから削除すること）`,
      ).toBe(0)
    }
  })
})
