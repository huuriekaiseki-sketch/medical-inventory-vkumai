// scripts/lib/scan-guard-regressions.mjs
//
// WHY(2026-09-08 に自分でやった): `CREATE OR REPLACE FUNCTION` は本文をまるごと差し替える。
//      **古い版を元に書き直すと、後から入った強化が黙って消える。**
//      その日 `20260908070000` が `get_order_amount_report` に「取り消しを除く」条件を足すため
//      関数を書き直したが、元にしたのが最初の版（20260715000003）だった。この関数は
//      **20260907000001 で `has_aal2()` の判定を足してあった**（#757-39 B-001）ので、
//      パスワードだけを奪われた admin（aal1）が全施設の金額を読める状態に戻っていた。
//
//      気づけたのは統合テスト（blast-radius の B-001）が落ちたからで、**書いた本人は気づいていない**。
//      落ちるテストがある強化は拾えるが、無いものは黙って消える。ここで機械的に見る。
//
// 何を見るか: migration をファイル名順（＝適用順）に畳み、同じ名前の関数が再定義されるたびに
//      **前の版にあった認可の判定が新しい版にあるか**を比べる。
//
// 落ちたら守りが弱くなるもの（順不同）:
//      is_admin() / has_aal2() / is_facility_member() / is_facility_writer() / SET search_path
//
// 強化は違反にしない: `is_facility_member()` が `is_facility_writer()` や `is_admin()` に
//      置き換わるのは**狭める**変更（viewer が落ちる）。20260805000001 が実際にそれをやっている。
//
// 意図して外すとき: migration に `-- drops-guard: <理由>` を書く。書けば違反にしない。
//      **理由が要る**（「面倒だから」で外させない）。
//
// 限界:
//   - **静的解析**。実 DB の `pg_proc` ではなく migration のテキストを読む
//   - **名前で見ているだけ**で、判定が実際に効く位置にあるかは見ない
//     （`IF NOT is_admin() THEN` を `IF true THEN` にすれば素通りする。それは変異検査の仕事）
//   - 引数の違う同名関数（オーバーロード）を区別しない。このリポジトリには無い
//   - テーブルの RLS ポリシーは対象外（`scan-rls-grant-gaps.mjs` が別の角度で見る）
//
// 使い方: node scripts/lib/scan-guard-regressions.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const GUARDS = [
  { name: 'is_admin()', re: /\bis_admin\s*\(/i },
  { name: 'has_aal2()', re: /\bhas_aal2\s*\(/i },
  { name: 'is_facility_member()', re: /\bis_facility_member\s*\(/i },
  { name: 'is_facility_writer()', re: /\bis_facility_writer\s*\(/i },
  { name: 'SET search_path', re: /\bset\s+search_path\b/i },
]

/** 「A が消えても B があれば守りは落ちていない」（B は A より狭い） */
const IMPLIES = {
  'is_facility_member()': ['is_facility_writer()', 'is_admin()'],
}

/** 関数の定義そのもの（本文の外にある宣言も拾う）。fail-open 防止の突合に使う */
const DEFINITION_RE = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?[a-z_][a-z0-9_]*\s*\(/gi
/**
 * 定義 1 件ぶん（頭 + 本文）。
 *
 * WHY(タグ付きのドル引用符に対応する): 本文は `$$` だけでなく `$function$` のような
 *      タグ付きでも囲める。`20260707000001` の `rls_auto_enable()` が実際にそれで
 *      （リモートの `pg_get_functiondef` の出力をそのまま転記したため）、
 *      `$$` 決め打ちだと**この 1 件を黙って読み飛ばしていた**。
 *      2026-09-08 に「タグ付きは無い」と grep で確かめたつもりが、
 *      `$` を正規表現の行末として解釈させる書き方をしていて **0 件と誤って読んだ**。
 *      気づけたのは下の「宣言の数と解析できた数を突き合わせる」空振り防止のほう。
 *      **確かめたつもりの grep より、数が合うかを見るほうが強い。**
 */
const PARSE_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*returns([\s\S]*?)\$([a-z_]*)\$([\s\S]*?)\$\4\$/gi

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

export function scan(migrationsDir = path.join(REPO_ROOT, 'supabase/migrations')) {
  /** 関数名 → 最後に定義した版 */
  const latest = new Map()
  const violations = []
  let declared = 0
  let parsed = 0

  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const sql = stripComments(raw)

    // WHY(コメントを外す前の生文字列で見る): 逃がす印はコメントに書くため。
    // WHY(同じ行に理由を求める): `\s*\S` だと改行をまたいで**次の行の先頭文字**を理由と読み、
    //      `-- drops-guard:`（理由なし）が通ってしまった（2026-09-08、fixture で検知）。
    //      空白は同じ行のもの（スペース・タブ）だけを許す。
    const allowed = /--[ \t]*drops-guard:[ \t]*\S/.test(raw)

    declared += [...sql.matchAll(DEFINITION_RE)].length

    for (const m of sql.matchAll(PARSE_RE)) {
      parsed += 1
      const name = m[1].toLowerCase()
      // m[3] = RETURNS 〜 AS の間（SECURITY DEFINER / SET search_path が入る）、m[5] = 本文
      const text = (m[3] ?? '') + (m[5] ?? '')
      const guards = new Set(GUARDS.filter((g) => g.re.test(text)).map((g) => g.name))

      const prev = latest.get(name)
      if (prev) {
        const lost = [...prev.guards].filter(
          (g) => !guards.has(g) && !(IMPLIES[g] ?? []).some((sub) => guards.has(sub))
        )
        if (lost.length > 0 && !allowed) {
          violations.push(
            `guard-lost: ${name} — ${prev.file} にあった ${lost.join(' / ')} が ${file} の再定義で消えた。` +
              `最後に定義した版を元に書き直すか、意図的なら migration に「-- drops-guard: 理由」を書く`
          )
        }
      }
      latest.set(name, { file, guards })
    }
  }

  return { latest, violations, declared, parsed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.GUARD_REGRESSION_DIR ?? path.join(REPO_ROOT, 'supabase/migrations')
  const { latest, violations, declared, parsed } = scan(dir)

  // fail-open 防止 1: 関数を 1 つも見つけられないと、違反ゼロで「合格」に見える
  if (latest.size === 0) {
    console.error('scan-guard-regressions: 関数を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: 宣言の数と解析できた数が食い違う＝**黙って読み飛ばしている**
  if (declared !== parsed) {
    console.error(
      `scan-guard-regressions: 関数の定義 ${declared} 件のうち ${parsed} 件しか解析できていない` +
        '（$$ 以外のドル引用符など、走査の想定外の書き方がある）'
    )
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    for (const [name, v] of [...latest].sort()) {
      console.log(`  ${name}: ${[...v.guards].sort().join(', ') || '判定なし'}（最後は ${v.file}）`)
    }
  }
  for (const v of violations) console.log(v)
  console.log(`functions=${latest.size} definitions=${parsed} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
