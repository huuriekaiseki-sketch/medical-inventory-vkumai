// issue: 短貸返却(loan_return)の二重登録(#675)の根本原因検知。
//
// WHY: #675 は「loan_order 1件に返却は1件まで」というカーディナリティの約束が
//      どこにも宣言されず、migration のテストが「実装で書いた SQL 文字列を同じ文字列で
//      照合する」静的検証だけだったため、PR #573(2026-07-26)から修正(2026-08-28)まで
//      84コミット・CI 173本を通過し続けても検出されなかった。
//
//      DB制約(UNIQUE / FK / CHECK)は「約束を破る操作が拒否されること」でしか検証できない。
//      静的SQL検証は原理的にそれを確かめられない(Act も 否定形の Assert も持てない)ため、
//      制約を導入する migration には実DBを使う統合テストの対応が要る。
//
//      ここでは「制約を導入しているのに、そのテーブルがどの統合テストにも一度も
//      登場しない migration」を機械検知する。判定は近似であり warning-only で運用する
//      (docs/agents/actuator-inventory.md)。
//
// 既知の限界:
//   - テーブル名が統合テストに登場すること = その制約が検証されていること、ではない。
//     つまり偽陰性(見逃し)は残る。「一度も登場しない」の側だけを高い確度で拾う設計。
//   - 意図的に統合テストを持たない migration は、SQL 内に
//     `-- integration-coverage: not-required <理由>` と書くことで除外できる
//     (「該当なしでも理由を書く」= 判断を記録に残す)。

import { readdirSync, readFileSync, existsSync, realpathSync } from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const OPT_OUT_PATTERN = /--\s*integration-coverage:\s*not-required\b(.*)$/im

/** SQL から行コメント・ブロックコメントを除去する（コメント中の CHECK 等を拾わないため） */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** この migration が導入している制約の種類を返す */
function detectConstraintKinds(sqlWithoutComments) {
  const s = sqlWithoutComments.toLowerCase()
  const kinds = []
  if (/\bunique\b/.test(s)) kinds.push('UNIQUE')
  if (/\breferences\s+/.test(s)) kinds.push('FK')
  if (/\bcheck\s*\(/.test(s)) kinds.push('CHECK')
  return kinds
}

/** 制約の「個数」を数える（種類ではなく実際の出現数。書き忘れの余地の大きさの代理指標） */
function countConstraints(sqlWithoutComments) {
  const s = sqlWithoutComments.toLowerCase()
  const count = (re) => (s.match(re) ?? []).length
  return count(/\bunique\b/g) + count(/\breferences\s+/g) + count(/\bcheck\s*\(/g)
}

/** この migration が触るテーブル名を粗く抽出する */
function extractTables(sqlWithoutComments) {
  const s = sqlWithoutComments.toLowerCase()
  const tables = new Set()
  const patterns = [
    /(?:create table(?:\s+if not exists)?|alter table(?:\s+if exists)?)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g,
    /create\s+(?:unique\s+)?index[^;]*?\bon\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g,
  ]
  for (const re of patterns) {
    for (const m of s.matchAll(re)) tables.add(m[1])
  }
  return [...tables]
}

/**
 * 制約を導入しているのに統合テストの対応が無い migration を洗い出す。
 *
 * @param {{migrations: {name: string, sql: string}[], integrationSource: string}} options
 *   options.integrationSource は統合テスト全ファイルを連結した文字列
 * @returns {{total: number,
 *            uncovered: {name: string, kinds: string[], tables: string[], constraintCount: number}[],
 *            optedOut: {name: string, reason: string}[]}}
 */
export function findUncoveredConstraintMigrations({ migrations, integrationSource }) {
  const haystack = String(integrationSource ?? '').toLowerCase()
  const uncovered = []
  const optedOut = []
  let total = 0

  for (const { name, sql } of migrations) {
    const optOut = OPT_OUT_PATTERN.exec(sql)
    const body = stripComments(sql)
    const kinds = detectConstraintKinds(body)
    if (kinds.length === 0) continue
    total += 1

    if (optOut) {
      optedOut.push({ name, reason: optOut[1].trim() })
      continue
    }

    const tables = extractTables(body)
    // テーブル名を1つも抽出できなかった migration（RLSポリシーのみ等）は判定対象外にする。
    // 「どのテーブルを守るのか」が分からない以上、カバレッジの有無を主張できないため。
    if (tables.length === 0) continue

    const covered = tables.some((t) => haystack.includes(t))
    if (!covered) uncovered.push({ name, kinds, tables, constraintCount: countConstraints(body) })
  }

  return { total, uncovered, optedOut }
}

/**
 * 検知した「穴」に怪しさ（高/中/低）を付ける。
 *
 * WHY: 検知結果をフラットな一覧で出すと「6件あります」で終わり、結局どれから見ればよいか
 *      分からず放置される。#675 が6週間残ったのは検知が無かったからだけでなく、
 *      仮に一覧があっても優先順位が付かず埋もれたはずだから。
 *      「怪しい/怪しくない」を機械で判定して並べ替えるところまでが検知の仕事とする。
 *
 * 判定材料はすべて機械的に取れるものだけを使う（人の申告に依存しない）:
 *   - usedByApp      : そのテーブルをアプリのコード(src/)が実際に読み書きしているか。
 *                      触っていないテーブル = システム自身の裏方（スキーマ監視等）で、
 *                      業務データが壊れるリスクが無い。最も効く信号。
 *   - facilityScoped : facility_id を持つか = 施設境界（医療データのテナント分離）に関わる
 *   - constraintCount: 制約の個数。多いほど「書き忘れの余地」が大きい
 *
 * @param {{tables: string[], constraintCount: number, appSource: string, allMigrationSql: string}} options
 * @returns {{level: 'high'|'medium'|'low', reasons: string[]}}
 */
export function assessRisk({ tables, constraintCount, appSource, allMigrationSql }) {
  const app = String(appSource ?? '').toLowerCase()
  const all = String(allMigrationSql ?? '').toLowerCase()

  const usedByApp = tables.some((t) => app.includes(t))
  // `create table <t>` に固定して探す。`create table[^;]*\bt\b` のように緩めると、
  // 別テーブルの定義内にFK参照先として現れた名前（例: hospital_prices の
  // `references distributor_products(id)`）に一致し、facility_id を持たないテーブルまで
  // 施設境界扱いになる（実装中に実際に踏んだ誤検知）
  let facilityScopeKind = null
  const facilityScoped = tables.some((t) => {
    const hasColumn = new RegExp(
      `create table\\s+(?:if not exists\\s+)?(?:public\\.)?"?${t}"?\\s*\\([^;]*facility_id`,
      's',
    ).test(all)
    // 明細テーブル（case_order_items / loan_return_items 等）は facility_id 列を持たず、
    // 親テーブル経由の EXISTS で施設スコープになる。列だけを見ると施設境界を
    // 取りこぼして medium に過小評価する（実際に踏んだ）。ポリシー本文で
    // is_facility_member を使っているかも併せて見る
    const policyScoped = new RegExp(
      `create policy[^;]*\\son\\s+(?:public\\.)?"?${t}"?[^;]*is_facility_member`,
      's',
    ).test(all)
    if (hasColumn) facilityScopeKind = 'column'
    else if (policyScoped) facilityScopeKind = 'policy'
    return hasColumn || policyScoped
  })

  const reasons = []
  if (!usedByApp) {
    reasons.push('アプリのコード(src/)がこのテーブルを一度も読み書きしていない（裏方テーブル）')
    return { level: 'low', reasons }
  }

  reasons.push('アプリのコード(src/)が実際に読み書きしている（業務データ）')
  if (facilityScopeKind === 'column') {
    reasons.push('facility_id を持つ＝施設境界（テナント分離）に関わる')
  } else if (facilityScopeKind === 'policy') {
    reasons.push('RLSポリシーが is_facility_member を使う＝親経由で施設境界に関わる')
  }
  if (constraintCount >= 3) reasons.push(`制約が${constraintCount}個あり、書き忘れの余地が大きい`)

  const level = facilityScoped || constraintCount >= 3 ? 'high' : 'medium'
  return { level, reasons }
}

const CARDINALITY_OPT_OUT = /--\s*cardinality:\s*many\b(.*)$/im

/**
 * 既存テーブルへ後付けで追加されたFK列のうち、カーディナリティ(1対1か1対多か)が
 * どこにも宣言されていないものを洗い出す。
 *
 * WHY: #675 の発生源は 20260714000005_orders_history_prereqs.sql の
 *      `ALTER TABLE loan_returns ADD COLUMN loan_order_id UUID REFERENCES loan_orders(id)` で、
 *      ここで「loan_order 1件に返却は何件まで許すのか」が一度も宣言されなかった。
 *      宣言されなかったので仕様書にも書かれず、テストにも出ず、レビューでも問われなかった。
 *      「関係を後付けする」操作はリポジトリ全体で数件しかないため、ここを塞ぐのは安い。
 *
 * 宣言済みとみなす条件は次のいずれか:
 *   - その列に UNIQUE 制約 / UNIQUE インデックスがある（= 1対1）
 *   - SQL 内に `-- cardinality: many <理由>` と書かれている（= 1対多だと明示した）
 *
 * @param {{migrations: {name: string, sql: string}[]}} options
 * @returns {{added: number, undeclared: {name: string, table: string, column: string}[],
 *            declaredMany: {name: string, column: string, reason: string}[]}}
 */
export function findUndeclaredCardinality({ migrations }) {
  const allStatements = migrations
    .map((m) => stripComments(m.sql))
    .join('\n')
    .toLowerCase()
    .split(';')

  const undeclared = []
  const declaredMany = []
  let added = 0

  for (const { name, sql } of migrations) {
    const body = stripComments(sql).toLowerCase()
    // 同じファイル内の宣言（そのmigrationを書いている最中の通常ケース）
    const optOut = CARDINALITY_OPT_OUT.exec(sql)

    // `ALTER TABLE <t> ... ADD COLUMN <col> <type> ... REFERENCES` を拾う。
    // CREATE TABLE 内のFKは「最初から多対1として設計された」ものが大半でノイズになるため対象外。
    for (const m of body.matchAll(
      /alter table\s+(?:if exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]*?add column\s+"?([a-z_][a-z0-9_]*)"?[^;]*?\breferences\b[^;]*?;/g,
    )) {
      const [, table, column] = m
      added += 1

      if (optOut) {
        declaredMany.push({ name, column, reason: optOut[1].trim() })
        continue
      }

      // 既に適用済みのmigrationを後から編集したくない場合のために、
      // `-- cardinality: many <table>.<column> <理由>` と列を明示すれば
      // **別のmigrationからでも**宣言できる（適用済みファイルを触らずに済ませる逃げ道）
      const remote = new RegExp(
        `--\\s*cardinality:\\s*many\\s+${table}\\.${column}\\b(.*)$`,
        'im',
      ).exec(migrations.map((mm) => mm.sql).join('\n'))
      if (remote) {
        declaredMany.push({ name, column, reason: remote[1].trim() })
        continue
      }

      // UNIQUE 宣言はこの migration 内とは限らない（#675 は1ヶ月後の別 migration で追加された）
      // ため、リポジトリ全体のSQLを文単位で見る。ただし「同じ文が当該テーブルと当該列の
      // 両方に言及していること」を要求する。列名だけで照合すると、無関係なテーブルの
      // 複合UNIQUE（例: product_compatibilities の UNIQUE (category_id, ...)）に
      // 誤って一致して宣言済みと誤判定する。
      const hasUnique = allStatements.some(
        (stmt) =>
          stmt.includes(table) &&
          new RegExp(`\\bunique\\b[^(]*\\([^)]*\\b${column}\\b`).test(stmt),
      )

      if (!hasUnique) undeclared.push({ name, table, column })
    }
  }

  return { added, undeclared, declaredMany }
}

/**
 * RLSポリシーを持つのに、IDOR統合テスト（他人のIDでアクセスして弾かれることの確認）に
 * 一度も登場しないテーブルを洗い出す。
 *
 * WHY: constraint-coverage と同じ型の穴を、認可の側で探す。
 *      「ポリシーを書いた」＝「他人から守られている」ではない。守られていることは
 *      **他人のIDで実際に叩いて弾かれる**ことでしか確かめられず、
 *      `known-failure-patterns.md`の「動いたからOKでfacility_idフィルタ漏れ・RLS未設定を
 *      見逃す（issue #24再発防止）」はまさにこれが起きた記録である。
 *
 * `notRequired` は「守るべき施設境界の約束がそもそも無い」テーブルの除外リスト。
 * 例: categories / distributor_products のようなマスタは意図的にテナント非分離で、
 * `USING (true)` の SELECT ポリシーを持つ。ここに IDOR の概念は無く、守る約束は
 * 施設境界ではなく admin 境界である。**これは負債の免除ではなく検知条件の訂正**であり、
 * 理由とセットでレビュー可能な場所（baseline）に置く。
 *
 * @param {{allMigrationSql: string, idorTestSource: string, notRequired?: string[]}} options
 * @returns {{policyTables: string[], uncovered: string[]}}
 */
export function findRlsTablesWithoutIdorTest({ allMigrationSql, idorTestSource, notRequired = [] }) {
  const sql = String(allMigrationSql ?? '').toLowerCase()
  const idor = String(idorTestSource ?? '').toLowerCase()

  const policyTables = new Set()
  for (const m of sql.matchAll(
    /create policy[^;]*?\bon\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g,
  )) {
    policyTables.add(m[1])
  }

  const excluded = new Set(notRequired)
  const tables = [...policyTables].sort()
  return {
    policyTables: tables,
    uncovered: tables.filter((t) => !idor.includes(t) && !excluded.has(t)),
  }
}

/**
 * 「adminだけが書ける」テーブルのうち、非adminが書けないことを一度も試していないものを探す。
 *
 * WHY: RLS/IDOR軸で `categories` / `distributor_products` / `product_compatibilities` を
 *      「施設境界の約束がそもそも無い」として除外したが、**代わりに admin 境界という
 *      別の約束が存在する**。除外したまま admin 側の軸を作らないと、
 *      「面倒な指摘を除外リストに逃がしただけ」になる。
 *
 *      `is_facility_member` / `is_facility_writer` との OR がある場合は
 *      「adminは追加の許可」であって admin境界ではないため対象外にする。
 *      （この区別を入れないと15テーブルが該当し、ノイズだらけになる。実測で確認）
 *
 * @param {{allMigrationSql: string, adminTestSource: string}} options
 * @returns {{adminOnlyTables: string[], uncovered: string[]}}
 */
export function findAdminOnlyTablesWithoutTest({ allMigrationSql, adminTestSource }) {
  const sql = String(allMigrationSql ?? '').toLowerCase()
  const tested = String(adminTestSource ?? '').toLowerCase()

  const tables = new Set()
  for (const m of sql.matchAll(
    /create policy[^;]*?\son\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?([^;]*)/g,
  )) {
    const [, table, rest] = m
    const isWrite = /for\s+(all|insert|update|delete)/.test(rest)
    const hasFacilityAlternative =
      rest.includes('is_facility_member') || rest.includes('is_facility_writer')
    if (isWrite && rest.includes('is_admin') && !hasFacilityAlternative) tables.add(table)
  }

  const adminOnlyTables = [...tables].sort()
  return { adminOnlyTables, uncovered: adminOnlyTables.filter((t) => !tested.includes(t)) }
}

/**
 * クライアントロール（anon / authenticated / PUBLIC 既定）から PostgREST 経由で呼べる RPC のうち、
 * 境界テスト（統合テスト・E2E の攻撃テスト）で一度も `.rpc('name')` として呼ばれていないものを探す。
 *
 * WHY: issue #757 の 34（未テスト経路の自動検出）。API Route は e2e の攻撃テストが fs で列挙して
 *      攻撃表に無ければ落とす（P-017）が、RPC は「テストを書いた関数だけ守られている」状態だった。
 *      PostgreSQL は CREATE FUNCTION した関数の EXECUTE を既定で PUBLIC に与えるため、
 *      GRANT を書かなくても authenticated / anon から呼べる。つまり「migration に関数を足した」
 *      時点で新しい経路が開いており、それを列挙する側が無いと守るテストの有無を誰も確かめない。
 *
 *      判定は migration を適用順に走査して最終状態を組み立てる:
 *        - CREATE [OR REPLACE] FUNCTION: 定義（RETURNS / SECURITY DEFINER）を更新。権限は維持
 *        - DROP FUNCTION: 定義と権限を消す（再 CREATE で PUBLIC 既定に戻る）
 *        - GRANT / REVOKE ... ON FUNCTION: role ごとの EXECUTE を記録。REVOKE FROM PUBLIC で既定を外す
 *      RETURNS trigger / event_trigger の関数は RPC として呼べないので対象外。public 以外の
 *      スキーマも対象外（PostgREST に公開されるのは public のみ）。
 *
 * 既知の限界:
 *   - `GRANT ... ON ALL FUNCTIONS IN SCHEMA` と `ALTER DEFAULT PRIVILEGES` は解釈しない（現状使っていない。
 *     使い始めたらここを拡張する。見逃す方向＝安全側ではないので unsupported として結果に出す）
 *   - 「テストに登場する」は `.rpc('name'` の文字列一致であり、他施設 id で拒否されることまでは保証しない
 *     （RLS/IDOR 軸と同じ偽陰性）。「一度も呼んでいない」側だけを高い確度で拾う
 *
 * @param {{migrations: {name: string, sql: string}[], boundaryTestSource: string, appSource?: string,
 *          notRequired?: string[]}} options
 * @returns {{functions: {name: string, definedIn: string, securityDefiner: boolean, exposedVia: string[],
 *                        appUses: boolean, tested: boolean}[],
 *            exposed: string[], uncovered: {name: string, risk: 'high'|'medium'|'low', reasons: string[]}[],
 *            unsupported: string[]}}
 */
export function findExposedRpcWithoutBoundaryTest({ migrations, boundaryTestSource, appSource = '', notRequired = [] }) {
  const state = new Map()
  const unsupported = []
  const identFor = (n) => `(?:"?public"?\\.)?"?(?<${n}>[a-z_][a-z0-9_]*)"?`
  const nonPublic = /^"?(auth|storage|extensions|cron|vault|net|pgsodium|realtime|supabase_functions)"?\./
  // 1 ファイル内でも「DROP → CREATE」「CREATE → GRANT」の順序が意味を持つので、文の種類ごとに
  // 別々に走査せず、1 本の正規表現で出現順に処理する
  const statement = new RegExp(
    [
      `(?<create>create (?:or replace )?function (?<schema>(?:"?[a-z_]+"?\\.)?)${identFor('cname')} ?\\((?:[^)]*)\\)(?<header>[\\s\\S]*?)\\bas (?:\\$|'))`,
      `(?<drop>drop function (?:if exists )?${identFor('dname')})`,
      `(?<priv>(?<verb>grant|revoke) (?:execute|all(?: privileges)?) on function ${identFor('pname')} ?(?:\\([^)]*\\))? (?:to|from) (?<roles>[a-z_, ]+?) ?;)`,
    ].join('|'),
    'g',
  )

  for (const { name: file, sql: raw } of migrations) {
    const lower = stripComments(raw).replace(/\s+/g, ' ').toLowerCase()
    if (/on all functions in schema|alter default privileges/.test(lower)) {
      unsupported.push(`${file}: ON ALL FUNCTIONS IN SCHEMA / ALTER DEFAULT PRIVILEGES は解釈していない`)
    }
    for (const m of lower.matchAll(statement)) {
      const g = m.groups
      if (g.create !== undefined) {
        const name = g.cname
        if (g.schema && nonPublic.test(g.schema)) continue
        const prev = state.get(name)
        state.set(name, {
          name,
          definedIn: file,
          returnsTrigger: /returns (?:trigger|event_trigger)\b/.test(g.header),
          securityDefiner: /security definer/.test(g.header),
          // CREATE OR REPLACE は権限を維持する。DROP 後の再 CREATE は prev が無いので既定に戻る。
          // 既定は 2 層ある: PostgreSQL の PUBLIC 既定と、Supabase が postgres ロールに設定している
          // ALTER DEFAULT PRIVILEGES（public スキーマの関数に anon / authenticated / service_role へ
          // 明示 EXECUTE）。後者は REVOKE FROM PUBLIC では消えない（2026-09-06 に CI の素の DB で実測。
          // get_admin_status は PUBLIC を外して authenticated に GRANT し直したのに anon が呼べた）
          publicExecute: prev ? prev.publicExecute : true,
          roles: prev
            ? prev.roles
            : new Map([
                ['anon', 'default'],
                ['authenticated', 'default'],
                ['service_role', 'default'],
              ]),
        })
      } else if (g.drop !== undefined) {
        state.delete(g.dname)
      } else if (g.priv !== undefined) {
        const fn = state.get(g.pname)
        if (!fn) continue
        const granted = g.verb === 'grant'
        for (const role of g.roles.split(',').map((r) => r.trim()).filter(Boolean)) {
          if (role === 'public') fn.publicExecute = granted
          else fn.roles.set(role, granted)
        }
      }
    }
  }

  const tests = String(boundaryTestSource ?? '').toLowerCase()
  const app = String(appSource ?? '').toLowerCase()
  const excluded = new Set(notRequired)
  const functions = []
  for (const fn of [...state.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (fn.returnsTrigger) continue
    const exposedVia = []
    if (fn.publicExecute) exposedVia.push('PUBLIC（PostgreSQL 既定。GRANT を書いていない）')
    for (const role of ['anon', 'authenticated']) {
      const v = fn.roles.get(role)
      if (v === true) exposedVia.push(role)
      else if (v === 'default') exposedVia.push(`${role}（Supabase 既定権限）`)
    }
    const callPattern = new RegExp(`rpc\\(\\s*['"]${fn.name}['"]`)
    functions.push({
      name: fn.name,
      definedIn: fn.definedIn,
      securityDefiner: fn.securityDefiner,
      exposedVia,
      appUses: callPattern.test(app),
      tested: callPattern.test(tests),
    })
  }

  const exposed = functions.filter((f) => f.exposedVia.length > 0)
  const uncovered = exposed
    .filter((f) => !f.tested && !excluded.has(f.name))
    .map((f) => {
      const reasons = []
      if (f.securityDefiner) reasons.push('SECURITY DEFINER（RLS を通らず、関数内の検査だけが境界）')
      if (f.exposedVia.some((v) => v.includes('既定'))) reasons.push('明示 GRANT が無く既定権限（PostgreSQL の PUBLIC / Supabase の ALTER DEFAULT PRIVILEGES）で呼べる')
      if (f.exposedVia.some((v) => v.startsWith('anon'))) reasons.push('anon（未ログイン）からも呼べる')
      if (f.appUses) reasons.push('アプリが呼んでいる（業務経路）')
      else reasons.push('アプリは呼んでいない（使われていない公開経路。REVOKE の候補）')
      const level = f.securityDefiner ? 'high' : f.appUses ? 'medium' : 'low'
      return { name: f.name, risk: level, reasons }
    })

  return { functions, exposed: exposed.map((f) => f.name), uncovered, unsupported }
}

// ---- CLI ----

const LEVEL_ORDER = { high: 0, medium: 1, low: 2 }
const LEVEL_LABEL = {
  high: '【怪しい】  ',
  medium: '【要確認】  ',
  low: '【放置でよい】',
}

/** 指定ディレクトリ配下のソースを再帰的に連結する（業務データ判定の材料） */
function collectSource(dirs, extensions) {
  const chunks = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extensions.some((ext) => entry.name.endsWith(ext))) chunks.push(readFileSync(full, 'utf-8'))
    }
  }
  dirs.forEach(walk)
  return chunks.join('\n').toLowerCase()
}

function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const migDir = path.join(repoRoot, 'supabase/migrations')
  const intDir = path.join(repoRoot, 'supabase/__tests__/integration')

  const migrations = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(migDir, f), 'utf-8') }))

  const integrationSource = existsSync(intDir)
    ? readdirSync(intDir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => readFileSync(path.join(intDir, f), 'utf-8'))
        .join('\n')
    : ''

  // 業務データかどうかの判定材料: アプリ本体のソース（生成物である型定義は除く）
  const appSource = collectSource(
    [
      path.join(repoRoot, 'src/lib'),
      path.join(repoRoot, 'src/app'),
      path.join(repoRoot, 'src/components'),
    ],
    ['.ts', '.tsx'],
  )
  const allMigrationSql = migrations.map((m) => m.sql).join('\n')

  const cardinality = findUndeclaredCardinality({ migrations })
  const coverage = findUncoveredConstraintMigrations({ migrations, integrationSource })

  const ranked = coverage.uncovered
    .map((u) => ({
      ...u,
      risk: assessRisk({
        tables: u.tables,
        constraintCount: u.constraintCount,
        appSource,
        allMigrationSql,
      }),
    }))
    .sort((a, b) => LEVEL_ORDER[a.risk.level] - LEVEL_ORDER[b.risk.level])

  // RPC 軸（issue #757 の 34）: 境界テスト＝統合テスト + e2e。アプリのソースは業務経路かどうかの材料
  const rpcBaselinePath = path.join(repoRoot, 'supabase/migrations/__tests__/constraint-coverage-baseline.json')
  const rpcBaseline = existsSync(rpcBaselinePath) ? JSON.parse(readFileSync(rpcBaselinePath, 'utf-8')) : {}
  const rpc = findExposedRpcWithoutBoundaryTest({
    migrations,
    boundaryTestSource: [integrationSource, collectSource([path.join(repoRoot, 'e2e')], ['.spec.ts'])].join('\n'),
    appSource,
    notRequired: (rpcBaseline.rpcNotRequired ?? []).map((e) => e.function),
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ cardinality, integrationCoverage: { ...coverage, ranked }, rpc }, null, 2))
    return
  }

  console.log('=== DB制約の穴（怪しい順） ===\n')

  console.log('■ 何回までOKかを宣言していない後付けFK列')
  if (cardinality.undeclared.length === 0) {
    console.log('  なし\n')
  } else {
    for (const u of cardinality.undeclared) {
      console.log(`  [要対応] ${u.table}.${u.column}  (${u.name})`)
      console.log('           → 1対1なら UNIQUE を追加、1対多なら `-- cardinality: many <理由>` を書く')
    }
    console.log('')
  }

  const idorSource = existsSync(intDir)
    ? readdirSync(intDir)
        .filter((f) => f.includes('idor'))
        .map((f) => readFileSync(path.join(intDir, f), 'utf-8'))
        .join('\n')
    : ''
  // 「守る約束がそもそも無い」テーブルの除外リストはbaselineが正本（理由付き）
  const baselinePath = path.join(repoRoot, 'supabase/migrations/__tests__/constraint-coverage-baseline.json')
  const notRequired = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf-8')).rlsIdorNotRequired ?? []).map((e) => e.table)
    : []
  const rls = findRlsTablesWithoutIdorTest({
    allMigrationSql,
    idorTestSource: idorSource,
    notRequired,
  })
  const rlsRanked = rls.uncovered
    .map((t) => ({
      table: t,
      risk: assessRisk({ tables: [t], constraintCount: 0, appSource, allMigrationSql }),
    }))
    .sort((a, b) => LEVEL_ORDER[a.risk.level] - LEVEL_ORDER[b.risk.level])

  console.log(
    `■ RLSポリシーはあるが、他人のIDで叩いて弾かれることを一度も試していない（${rls.uncovered.length}/${rls.policyTables.length}テーブル）`,
  )
  if (rlsRanked.length === 0) {
    console.log('  なし\n')
  } else {
    for (const r of rlsRanked) {
      console.log(`  ${LEVEL_LABEL[r.risk.level]} ${r.table}`)
      for (const reason of r.risk.reasons) console.log(`           - ${reason}`)
    }
    console.log('')
  }

  const adminTestSource = existsSync(intDir)
    ? readdirSync(intDir)
        .filter((f) => f.includes('admin'))
        .map((f) => readFileSync(path.join(intDir, f), 'utf-8'))
        .join('\n')
    : ''
  const admin = findAdminOnlyTablesWithoutTest({ allMigrationSql, adminTestSource })
  const adminRanked = admin.uncovered
    .map((t) => ({
      table: t,
      risk: assessRisk({ tables: [t], constraintCount: 0, appSource, allMigrationSql }),
    }))
    .sort((a, b) => LEVEL_ORDER[a.risk.level] - LEVEL_ORDER[b.risk.level])

  console.log(
    `■ adminだけが書けるはずだが、非adminで書けないことを試していない（${admin.uncovered.length}/${admin.adminOnlyTables.length}テーブル）`,
  )
  if (adminRanked.length === 0) {
    console.log('  なし\n')
  } else {
    for (const r of adminRanked) {
      console.log(`  ${LEVEL_LABEL[r.risk.level]} ${r.table}`)
      for (const reason of r.risk.reasons) console.log(`           - ${reason}`)
    }
    console.log('')
  }

  const rpcRanked = [...rpc.uncovered].sort((a, b) => LEVEL_ORDER[a.risk] - LEVEL_ORDER[b.risk])
  console.log(
    `■ クライアント（anon / authenticated）から呼べるのに、境界テストで一度も呼んでいないRPC（${rpc.uncovered.length}/${rpc.exposed.length}関数）`,
  )
  if (rpcRanked.length === 0) {
    console.log('  なし\n')
  } else {
    for (const r of rpcRanked) {
      console.log(`  ${LEVEL_LABEL[r.risk]} ${r.name}`)
      for (const reason of r.reasons) console.log(`           - ${reason}`)
    }
    console.log('           → 他施設・非admin・anon で .rpc() を呼んで拒否されるテストを書くか、公開不要なら REVOKE する')
    console.log('')
  }
  for (const u of rpc.unsupported) console.log(`  [解釈不能] ${u}`)

  console.log('■ 制約を作ったが、実DBで効くか一度も試していない')
  if (ranked.length === 0) {
    console.log('  なし')
  } else {
    for (const r of ranked) {
      console.log(`  ${LEVEL_LABEL[r.risk.level]} ${r.tables.join(', ')}  (制約${r.constraintCount}個: ${r.kinds.join('/')})`)
      console.log(`           ${r.name}`)
      for (const reason of r.risk.reasons) console.log(`           - ${reason}`)
    }
  }
}

// WHY(issue #806): 素の比較（import.meta.url と、argv[1] の前に file:// を付けた文字列）だと、symlink を含むパスで
//      起動したとき（例: macOS の一時ディレクトリ）に一致せず、main() が走らないまま無出力・exit 0 で終わる。
//      import.meta.url は実体パス、argv[1] は symlink のままだからである。検査にとって無出力・exit 0 は
//      「問題なし」と見分けがつかないので、実体パスへ直してから比べる。
//      この書き方へ戻すと、直接起動の判定を走査する検査（issue #806）が落とす
function isRunAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
if (isRunAsCli()) {
  main()
}
