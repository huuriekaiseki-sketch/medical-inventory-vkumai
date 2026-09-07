// WHY: issue #757 の 24。「どのテーブルに監査トリガーが付いているか」の正本は
//      migration の SQL であって、どこかに書き写した一覧ではない。
//      静的検査（supabase/migrations/__tests__/audit_trigger_coverage.test.ts）と
//      実測（supabase/__tests__/integration/audit-completeness.integration.test.ts）が
//      別々に一覧を持つと、その 2 つがズレたときに誰も気づかない。
//      そこで走査そのものをここ 1 か所に置き、両方から呼ぶ。

import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

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

/** 最終的に存在するテーブル名 → それを作った migration */
export function tablesFromMigrations(): Map<string, string> {
  const tables = new Map<string, string>()
  for (const file of migrationFiles()) {
    const sql = stripNonDdl(readMigration(file))
    for (const statement of sql.split(';')) {
      const created = statement.match(
        /create table (?:if not exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)(?:\s|\()/,
      )
      if (created) {
        tables.set(normalizeTableName(created[1]), file)
        continue
      }
      const dropped = statement.match(
        /drop table (?:if exists )?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/,
      )
      if (dropped) tables.delete(normalizeTableName(dropped[1]))
    }
  }
  return tables
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

    for (const block of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/g)) {
      for (const name of block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) audited.add(name[1])
    }

    for (const t of sql.matchAll(
      /create trigger\s+"?[a-z0-9_]+"?\s+after[^;]*?\son\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)[^;]*?audit_row_change/g,
    )) {
      audited.add(normalizeTableName(t[1]))
    }

    for (const t of sql.matchAll(
      /drop trigger\s+(?:if exists\s+)?"?[a-z0-9_]+_audit"?\s+on\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/g,
    )) {
      audited.delete(normalizeTableName(t[1]))
    }
  }
  return audited
}
