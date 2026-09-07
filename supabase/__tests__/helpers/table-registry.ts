// WHY: 2026-09-07。新しい表を作るときに決めることは 4 つある。
//        (1) RLS を有効にするか  (2) ポリシーを作るか
//        (3) **誰が読み書きできるか**  (4) 監査対象にするか
//      ところが検査は (1)(2) が rls_enabled_all_tables、(4) が audit_trigger_coverage と
//      別々にあり、**(3) を見る検査は 1 つも無かった**。しかも許可リストが 2 ファイルに散っていて、
//      新しい表を作った人が両方に書き忘れれば両方とも緑のままだった。
//
//      その結果 `schema_drift_log` は作られてから 2 か月間 GRANT が 1 行も無く、
//      **service_role でも読めなかった**。それを守るはずのテストは赤で放置された。
//
//      決めごとの正本は docs/agents/table-rulebook.md（TB-xxx）の 1 枚だけにした。
//      ここはその表を読んで機械が使える形にするだけで、**判断は 1 文字も持たない**。
//      TS に書き写すと、また「2 か所」に戻ってしまう。
//
//      表の「形」（列数・ID・状態の語彙・守るテストのパス実在）は汎用エンジン
//      scripts/lib/check-catalog.mjs が見る。「中身」（宣言と migration の実態の一致）は
//      supabase/migrations/__tests__/table_registry.test.ts が見る。

import { readFileSync } from 'fs'
import path from 'path'
import { CLIENT_ROLES, type ClientRole } from './table-facts'

export const TABLE_RULEBOOK_PATH = 'docs/agents/table-rulebook.md'

/** 'あり' か、そうしない理由 */
export type Decision = 'あり' | string

export interface TableDecl {
  id: string
  /** SELECT を持つ client ロール（postgres は所有者なので対象外） */
  reads: ClientRole[]
  /** INSERT / UPDATE / DELETE / TRUNCATE のどれかを持つ client ロール */
  writes: ClientRole[]
  policies: Decision
  audit: Decision
  /** 守るテストのパス（バッククォートを外したもの） */
  guardedBy: string[]
}

function repoRoot(): string {
  return path.resolve(__dirname, '../../..')
}

/** `authenticated / service_role` → ['authenticated','service_role']、`なし` → [] */
function parseRoles(cell: string): ClientRole[] {
  const trimmed = cell.trim()
  if (trimmed === 'なし') return []
  const roles = trimmed
    .split('/')
    .map((r) => r.trim())
    .filter(Boolean)
  const unknown = roles.filter((r) => !(CLIENT_ROLES as readonly string[]).includes(r))
  if (unknown.length > 0) {
    throw new Error(
      `${TABLE_RULEBOOK_PATH}: 知らないロール ${unknown.join(', ')}（${CLIENT_ROLES.join(' / ')} か「なし」）`,
    )
  }
  return roles as ClientRole[]
}

function parsePaths(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/** テーブル名 → 決めごと。正本は docs/agents/table-rulebook.md */
export function loadTableRulebook(): Record<string, TableDecl> {
  const text = readFileSync(path.join(repoRoot(), TABLE_RULEBOOK_PATH), 'utf-8')
  const out: Record<string, TableDecl> = {}

  for (const line of text.split('\n')) {
    if (!/^\|\s*TB-/.test(line)) continue
    // 先頭と末尾の `|` の外側は空文字
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length !== 8) {
      throw new Error(`${TABLE_RULEBOOK_PATH}: 8 列でない行がある（${cells[0]}）`)
    }
    const [id, table, policies, reads, writes, audit, guarded] = cells
    if (out[table]) throw new Error(`${TABLE_RULEBOOK_PATH}: ${table} の行が 2 つある`)
    out[table] = {
      id,
      reads: parseRoles(reads),
      writes: parseRoles(writes),
      policies,
      audit,
      guardedBy: parsePaths(guarded),
    }
  }

  // fail-open 防止: 表が読めなくなったら「宣言 0 件」＝全部素通りになるので、ここで落とす
  if (Object.keys(out).length < 15) {
    throw new Error(`${TABLE_RULEBOOK_PATH} から読めた行が ${Object.keys(out).length} 件しかない`)
  }
  return out
}

export const TABLE_REGISTRY: Record<string, TableDecl> = loadTableRulebook()

/** 意図的にポリシーを作らない表（rls_enabled_all_tables.test.ts が読む） */
export const INTENTIONALLY_POLICYLESS_TABLES: ReadonlySet<string> = new Set(
  Object.entries(TABLE_REGISTRY)
    .filter(([, decl]) => decl.policies !== 'あり')
    .map(([name]) => name),
)

/** 意図的に監査対象から外す表 → その理由（audit_trigger_coverage.test.ts が読む） */
export const AUDIT_EXEMPT_TABLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TABLE_REGISTRY)
    .filter(([, decl]) => decl.audit !== 'あり')
    .map(([name, decl]) => [name, decl.audit]),
)
