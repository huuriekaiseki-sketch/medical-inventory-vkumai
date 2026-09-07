// WHY: issue #757 の 27 の続き。「どのロールが何をできるか」は **4 か所**に別々に書いてある。
//        (1) DB の CHECK（`user_facilities_role_check`）… ロールの一覧そのもの
//        (2) `is_facility_writer()` … 施設の行を書けるロール
//        (3) `is_admin()` … マスタを書けるロール
//        (4) `src/hooks/useFacilityRole.ts` の `canWrite` … 画面が書き込み UI を出すロール
//      加えて `src/types/role.ts` の `FACILITY_ROLES` が TypeScript 側の一覧を持つ。
//
//      4 つとも**許可リスト**（載っていないロールは何もできない）なので、
//      新しいロールを足しても勝手に権限が生えることは無い。そこは良い設計。
//      問題は**互いに一致しているかを誰も見ていない**こと。実際に viewer を足したときは
//      TS 側の許可リスト更新漏れで誤表示が 2 回起きている（src/types/role.ts の WHY）。
//
//      さらに、新しいロールを足しても**そのロールを測るテストは 1 本も増えない**。
//      「4 つ目のロールがすり抜ける」とはこの状態を指す。
//
//      ここは実物から取り出す走査だけを置く。「そうであるべきか」の宣言は
//      docs/agents/role-rulebook.md（R-xxx）1 枚にまとめる。

import { readFileSync } from 'fs'
import path from 'path'
import { migrationFiles, readMigration, stripComments } from './table-facts'

function repoRoot(): string {
  return path.resolve(__dirname, '../../..')
}

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot(), rel), 'utf-8')
}

/** `'a', 'b'` → ['a','b']（並び順は宣言順を保つ） */
function quotedList(raw: string): string[] {
  return [...raw.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

/**
 * DB が受け付けるロールの一覧。`user_facilities_role_check` の CHECK を
 * migration の適用順に畳み込み、**最後に書かれたもの**を採る。
 */
export function rolesFromCheckConstraint(): string[] {
  let latest: string[] | null = null
  for (const file of migrationFiles()) {
    const sql = stripComments(readMigration(file))
    for (const m of sql.matchAll(
      /add constraint user_facilities_role_check\s+check\s*\(\s*role in \(([^)]*)\)/g,
    )) {
      latest = quotedList(m[1])
    }
  }
  if (latest === null || latest.length === 0) {
    throw new Error('user_facilities_role_check の CHECK を migration から読めない（走査が壊れている）')
  }
  return latest
}

/** SQL 関数の本体から `role in ('a','b')` / `role = 'a'` の許可リストを取り出す */
function rolesInFunction(functionName: string): string[] {
  let latest: string[] | null = null
  for (const file of migrationFiles()) {
    const sql = stripComments(readMigration(file))
    // 関数定義の開始位置から、次の `$$;`（本体の終わり）までを見る
    const start = sql.indexOf(`create or replace function ${functionName}(`)
    if (start < 0) continue
    const body = sql.slice(start, sql.indexOf('$$;', start))
    const inList = body.match(/role in \(([^)]*)\)/)
    if (inList) {
      latest = quotedList(inList[1])
      continue
    }
    const eq = body.match(/role = '([a-z_]+)'/)
    if (eq) latest = [eq[1]]
  }
  if (latest === null || latest.length === 0) {
    throw new Error(`${functionName}() の許可リストを migration から読めない（走査が壊れている）`)
  }
  return latest
}

/** 施設の行を書けるロール（`is_facility_writer()` の許可リスト） */
export function writerRolesFromSql(): string[] {
  return rolesInFunction('is_facility_writer')
}

/** マスタを書けるロール（`is_admin()` の許可リスト） */
export function adminRolesFromSql(): string[] {
  return rolesInFunction('is_admin')
}

/** TypeScript 側のロール一覧（`src/types/role.ts` の FACILITY_ROLES） */
export function rolesFromTypeScript(): string[] {
  const src = readSrc('src/types/role.ts')
  const m = src.match(/FACILITY_ROLES\s*=\s*\[([^\]]*)\]/)
  if (!m) throw new Error('src/types/role.ts から FACILITY_ROLES を読めない')
  const roles = quotedList(m[1])
  if (roles.length === 0) throw new Error('FACILITY_ROLES が空に見える（走査が壊れている）')
  return roles
}

/** 画面が書き込み UI を出すロール（`useFacilityRole.ts` の canWrite） */
export function writerRolesFromUi(): string[] {
  const src = readSrc('src/hooks/useFacilityRole.ts')
  // WHY(型宣言を飛ばす): 同じファイルに `canWrite: boolean`（型）と
  //      `canWrite: role === 'admin' || ...`（実装）の 2 つがある。
  //      ロール名を含む方だけを実装と見なす（最初の一致を採ると型を読んでしまう。実測で踏んだ）。
  const candidates = [...src.matchAll(/canWrite:\s*([^,\n]+)/g)]
    .map((m) => quotedList(m[1]))
    .filter((roles) => roles.length > 0)
  if (candidates.length === 0) {
    throw new Error('useFacilityRole.ts の canWrite からロール名を読めない（比較の書き方が変わった可能性）')
  }
  if (candidates.length > 1) {
    throw new Error('useFacilityRole.ts に canWrite の実装が 2 つある（走査が当てにならない）')
  }
  return candidates[0]
}
