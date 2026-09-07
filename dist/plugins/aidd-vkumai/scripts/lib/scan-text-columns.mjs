// WHY: issue #757 の 20。自由入力の列に上限が無いと、API を通らない経路から
//      いくらでも長い文字列が入る（2026-09-07 は 1 MB が保存できた）。
//      新しい列が上限なしで増えたことに気づけるよう、migration を適用順に畳み込んで
//      「上限も固定語も無い TEXT 列」を機械で出す。
//
// 判定:
//   guarded  … length(col) <= N の CHECK がある
//   bounded  … col IN ('a','b') の CHECK がある（固定語なので長さは自然に上限がある）
//   unguarded… どちらも無い = 自由入力なのに上限が無い
//
// 使い方: node scripts/lib/scan-text-columns.mjs <migrations ディレクトリ>
//   出力は JSON（{ total, guarded, bounded, unguarded }）。

import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/lib/scan-text-columns.mjs <migrations dir>')
  process.exit(2)
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

/** "table.column" の集合 */
const columns = new Set()
const lengthGuarded = new Set()
const enumBounded = new Set()
const strip = (sql) =>
  sql
    // 関数本体（$$ ... $$）は DDL ではないので丸ごと除く
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

const TEXTISH = /^"?([a-z_][a-z0-9_]*)"?\s+(text|varchar|character\s+varying)/i

for (const f of files) {
  const sql = strip(fs.readFileSync(path.join(dir, f), 'utf8'))

  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\)/gi
  )) {
    const table = m[1].toLowerCase()
    for (const line of m[2].split('\n')) {
      const c = line.trim().match(TEXTISH)
      if (c) columns.add(`${table}.${c[1].toLowerCase()}`)
    }
    // WHY(2026-09-07): インライン CHECK も**表に紐づけて**持つ。以前は列名だけで持っていたため、
    //      別の表に同じ列名で上限を付けると、上限の無い表の列まで「上限あり」と誤判定した
    //      （privileged_operations.method に length(method) <= 10 を足したら
    //      access_denials.method が guarded になり、一覧の消し忘れとして報告された）。
    //      CREATE TABLE の本体はここで表名つきに取れているので、同じ場所で紐づければよい。
    for (const c of m[2].matchAll(/(?:char_)?length\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*<=/gi)) {
      lengthGuarded.add(`${table}.${c[1].toLowerCase()}`)
    }
    for (const c of m[2].matchAll(/check\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s+in\s*\(/gi)) {
      enumBounded.add(`${table}.${c[1].toLowerCase()}`)
    }
  }

  // WHY(2026-09-07): 1 つの ALTER TABLE に ADD COLUMN が複数ある形
  //      （`ADD COLUMN name TEXT, ADD COLUMN maker TEXT;`）で、以前は **1 つ目しか拾えていなかった**。
  //      2 つ目以降の前に `alter table` が無いため、文全体を取ってからその中を走査する。
  //      これで `products.maker` が走査に一度も出ていなかったのが直る（上限の有無すら見えていなかった）。
  for (const stmt of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi
  )) {
    const table = stmt[1].toLowerCase()
    for (const c of stmt[2].matchAll(
      /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+(text|varchar|character\s+varying)/gi
    )) {
      columns.add(`${table}.${c[1].toLowerCase()}`)
    }
  }

  for (const m of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi
  )) {
    columns.delete(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
  }

  for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    const t = m[1].toLowerCase() + '.'
    for (const key of [...columns]) if (key.startsWith(t)) columns.delete(key)
  }

  // ALTER TABLE ... CHECK ( ... )
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,120}?check\s*\(([\s\S]*?)\)\s*(?:not\s+valid)?\s*;/gi
  )) {
    const table = m[1].toLowerCase()
    for (const c of m[2].matchAll(/(?:char_)?length\s*\(\s*"?([a-z_][a-z0-9_]*)"?\s*\)\s*<=/gi)) {
      lengthGuarded.add(`${table}.${c[1].toLowerCase()}`)
    }
    for (const c of m[2].matchAll(/"?([a-z_][a-z0-9_]*)"?\s+in\s*\(/gi)) {
      enumBounded.add(`${table}.${c[1].toLowerCase()}`)
    }
  }

  // WHY(2026-09-07 に削除): ここには「表名を伴わないインライン CHECK を列名だけで持つ」
  //      処理があった。表をまたいで誤判定するため、CREATE TABLE の解析の中で
  //      表名つきに紐づける形へ移した（上を参照）。
}

const guarded = []
const bounded = []
const unguarded = []
for (const key of [...columns].sort()) {
  if (lengthGuarded.has(key)) guarded.push(key)
  else if (enumBounded.has(key)) bounded.push(key)
  else unguarded.push(key)
}

console.log(JSON.stringify({ total: columns.size, guarded, bounded, unguarded }, null, 2))
