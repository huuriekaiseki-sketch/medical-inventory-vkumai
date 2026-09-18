// WHY: issue #757 の 24 の作業中に分かったこと。
//      新しい表を作るときに決めることは 4 つある（RLS を有効にするか / ポリシーを作るか /
//      **誰が読み書きできるか** / 監査対象にするか）。ところが検査は 3 つぶんしか無く、
//      しかも別々のファイルに散っていた。抜けていたのが「誰が読み書きできるか」で、
//      その結果 `schema_drift_log` は作られてから 2 か月間、**service_role でも読めなかった**。
//      （RLS のバイパスとテーブル権限は別の話。GRANT を書かなければ誰も読めない。）
//
//      ここは 4 軸ぶんの「実際どうなっているか」を migration から取り出す走査だけを置く。
//      「そうであるべきか」の宣言は supabase/migrations/__tests__/table_registry.test.ts に 1 枚でまとめる。
//
// 既知の限界: Supabase の既定権限（ALTER DEFAULT PRIVILEGES）はここからは見えない。
//      実測でも、既定が効いている表（audit_log の注記）と効いていない表（schema_drift_log）の
//      両方があった。だから registry 側は「既定がどうであれ、明示的に REVOKE してから
//      GRANT を書いたか」を要求する。環境の既定に答えを委ねないための設計。

import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

/** 宣言の対象にするロール（postgres は所有者なので対象外） */
export const CLIENT_ROLES = ['anon', 'authenticated', 'service_role'] as const
export type ClientRole = (typeof CLIENT_ROLES)[number]

const WRITE_PRIVILEGES = ['insert', 'update', 'delete', 'truncate'] as const

/** 行コメント・ブロックコメントだけ落とす（$$ 本体の中に対象一覧があるので消さない） */
export function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** DDL 走査用: $$ 本体・文字列リテラルまで落とす（CREATE TABLE の誤検出を防ぐ） */
export function stripNonDdl(sql: string): string {
  return sql
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function normalizeTableName(raw: string): string {
  return raw.replace(/"/g, '').replace(/^public\./, '')
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export function readMigration(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
}

export interface TableFacts {
  createdIn: string
  rlsEnabled: boolean
  policyCount: number
  /** ロール → 与えられている権限（all は展開して入れる） */
  grants: Record<string, Set<string>>
  /** client ロール 3 つすべてから REVOKE ALL したか（既定に答えを委ねていない印） */
  revokedFromAllClientRoles: boolean
}

function emptyFacts(createdIn: string): TableFacts {
  return {
    createdIn,
    rlsEnabled: false,
    policyCount: 0,
    grants: {},
    revokedFromAllClientRoles: false,
  }
}

function expandPrivileges(raw: string): string[] {
  const list = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (list.some((p) => p === 'all' || p.startsWith('all '))) {
    return ['select', ...WRITE_PRIVILEGES, 'references', 'trigger']
  }
  return list
}

function parseRoles(raw: string): string[] {
  return raw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
}

/**
 * 全 migration をファイル名順（＝適用順）に畳み込み、最終的なテーブルの姿を組み立てる。
 * CREATE / DROP TABLE、RLS の有効化、ポリシー数、GRANT / REVOKE を追う。
 */
export function scanTableFacts(): Map<string, TableFacts> {
  const tables = new Map<string, TableFacts>()

  for (const file of migrationFiles()) {
    const sql = stripNonDdl(readMigration(file))

    for (const statement of sql.split(';')) {
      const created = statement.match(
        /create table (?:if not exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)(?:\s|\()/,
      )
      if (created) {
        tables.set(normalizeTableName(created[1]), emptyFacts(file))
        continue
      }

      const dropped = statement.match(
        /drop table (?:if exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/,
      )
      if (dropped) {
        tables.delete(normalizeTableName(dropped[1]))
        continue
      }

      const enabled = statement.match(
        /alter table (?:if exists )?(?:only )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?) enable row level security/,
      )
      if (enabled) {
        const facts = tables.get(normalizeTableName(enabled[1]))
        if (facts) facts.rlsEnabled = true
        continue
      }

      const policy = statement.match(
        /create policy "?[a-z0-9_]+"? on ((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/,
      )
      if (policy) {
        const facts = tables.get(normalizeTableName(policy[1]))
        if (facts) facts.policyCount += 1
        continue
      }

      // 関数への EXECUTE は対象外（ここで見たいのはテーブルの読み書き）
      if (/ on (function|schema|sequence|all )/.test(statement)) continue

      const granted = statement.match(
        /grant ([a-z, ]+?) on (?:table )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?) to ([a-z_, ]+)/,
      )
      if (granted) {
        const facts = tables.get(normalizeTableName(granted[2]))
        if (facts) {
          for (const role of parseRoles(granted[3])) {
            facts.grants[role] ??= new Set()
            for (const p of expandPrivileges(granted[1])) facts.grants[role].add(p)
          }
        }
        continue
      }

      const revoked = statement.match(
        /revoke ([a-z, ]+?) on (?:table )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?) from ([a-z_, ]+)/,
      )
      if (revoked) {
        const facts = tables.get(normalizeTableName(revoked[2]))
        if (facts) {
          const roles = parseRoles(revoked[3])
          const privileges = expandPrivileges(revoked[1])
          for (const role of roles) {
            const held = facts.grants[role]
            if (held) for (const p of privileges) held.delete(p)
          }
          // 「既定に答えを委ねない」印: client ロール 3 つすべてから ALL を外している
          if (
            privileges.includes('select') &&
            CLIENT_ROLES.every((r) => roles.includes(r))
          ) {
            facts.revokedFromAllClientRoles = true
          }
        }
      }
    }
  }

  return tables
}

/** SELECT を持つ client ロール */
export function readersOf(facts: TableFacts): ClientRole[] {
  return CLIENT_ROLES.filter((r) => facts.grants[r]?.has('select'))
}

/** 書き込み系の権限をどれか持つ client ロール */
export function writersOf(facts: TableFacts): ClientRole[] {
  return CLIENT_ROLES.filter((r) => WRITE_PRIVILEGES.some((p) => facts.grants[r]?.has(p)))
}

/**
 * 監査トリガー（audit_row_change）が最終的に付いているテーブル名。
 * 一括登録（DO ブロックの FOREACH）・個別の CREATE TRIGGER・DROP TRIGGER の 3 通りを追う。
 */
export function auditedTablesFromMigrations(): Set<string> {
  const audited = new Set<string>()
  for (const file of migrationFiles()) {
    const sql = stripComments(readMigration(file))
    if (!sql.includes('audit_row_change')) continue

    // WHY(出現順に処理する): 1 つの migration が「外して付け直す」ことがある
    //      （20260907008000 が明細 4 表を DROP → CREATE している）。
    //      作成をまとめて処理してから削除をまとめて処理すると、削除が後勝ちになって
    //      「付け直したのに外れている」と誤って読む（実際にこれで誤検知した）。
    const events: Array<{ at: number; add?: string[]; remove?: string }> = []

    for (const block of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/g)) {
      events.push({
        at: block.index ?? 0,
        add: [...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]),
      })
    }

    for (const t of sql.matchAll(
      /create trigger\s+"?[a-z0-9_]+"?\s+after[^;]*?\son\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)[^;]*?audit_row_change/g,
    )) {
      events.push({ at: t.index ?? 0, add: [normalizeTableName(t[1])] })
    }

    for (const t of sql.matchAll(
      /drop trigger\s+(?:if exists\s+)?"?[a-z0-9_]+_audit"?\s+on\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/g,
    )) {
      events.push({ at: t.index ?? 0, remove: normalizeTableName(t[1]) })
    }

    for (const e of events.sort((a, b) => a.at - b.at)) {
      if (e.add) for (const name of e.add) audited.add(name)
      if (e.remove) audited.delete(e.remove)
    }
  }
  return audited
}

/** 最終的に存在するテーブル名 → それを作った migration（既存の呼び出し元との互換のため残す） */
export function tablesFromMigrations(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, facts] of scanTableFacts()) out.set(name, facts.createdIn)
  return out
}
