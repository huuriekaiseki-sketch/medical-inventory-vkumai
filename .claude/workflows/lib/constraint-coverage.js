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

import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ cardinality, integrationCoverage: { ...coverage, ranked } }, null, 2))
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
