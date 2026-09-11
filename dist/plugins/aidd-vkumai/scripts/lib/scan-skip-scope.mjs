// scripts/lib/scan-skip-scope.mjs
//
// WHY(2026-09-10、C-033「前提の範囲が、それを必要とする検査より広い」):
//      `e2e/api-cross-facility-attack.spec.ts` の
//      「攻撃表は実在する route × メソッドと過不足なく対応する（ratchet）」は、
//      **ファイルを読むだけ**の検査だった。DB もブラウザも要らない。
//      ところが同じ `test.describe` の直下に
//
//        test.skip(!fixtures || !fixtures.loanOrderId, 'cross-facility フィクスチャが無い')
//        test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定')
//
//      が書いてあり（**スナップショット比較のための前提**）、describe 直下の test.skip は
//      その describe 内の全テストに効くので、**ratchet も一緒にスキップされていた**。
//      Supabase を止めている間はずっと、E2E を回しても実行されない。
//
//      実害は同日に実測した: 認可チェックの無い route（`/api/authcheck-probe/[id]`）を
//      実コードへ置いて回帰を回したところ、typecheck / lint / check-operation-contracts /
//      check-access-path-inventory / check-input-validation-coverage /
//      check-query-validation-coverage / check-threat-model の **7 本すべてが通った**。
//      唯一気づけるはずだった ratchet が、この巻き込みで黙っていた。
//
//      **スキップは失敗ではないので、レポート上は緑と同じ色で出る。** 何本が実行されな
//      かったかを数える習慣が無いと、誰も気づかない。
//
// 何を見るか: `e2e/*.spec.ts` の各 `test.describe` ブロックについて、
//      (a) ブロックの**直下**に `test.skip(<条件>, ...)` があり（＝全テストに効く前提）
//      (b) そのブロック内に**同期テスト**（`test('...', () => {`）がある
//   なら違反にする。同期テストは `await` できないので、DB にもブラウザにも到達しようがない
//   ＝ **その前提を必要としない検査**である。逃がし口は `// skip-scope-ok: <理由>`。
//
//   `async () => {}` は対象にしない。引数を取らなくても中で `await` できるので、
//   本当に前提が要るかを静的には決められない（**過検知で信用を失うほうが高くつく**）。
//
// 限界:
//   - **静的解析**。describe の範囲はインデントで取る（`test.describe(` と同じ列の `})` まで）。
//     整形が崩れている spec では範囲を取り違える
//   - 同期テストしか見ないので、「`async` だが実際は前提が要らない」テストは見つけられない
//   - `test.skip()`（条件なし・そのテスト単体のスキップ）と `test.describe.skip` は対象外
//   - スキップの実行時の件数は見ない（それは E2E を回さないと分からない）
//   - **vitest 側（`it.skipIf` / `describe.skipIf` / `ctx.skip()`）は見ていない。**
//     2026-09-10 に実測したところ、テストファイル 296 本に対して
//     `skipIf` 0 件 / `ctx.skip()` 0 件 / `runIf` 1 件で、その 1 件
//     （`order-items-rls-idor.integration.test.ts`）は**表ごとの定数**による分岐であり、
//     宣言と実態の食い違いは同じ describe の別テストが両方向で突き合わせている。
//     つまり今のところ同じ型は無い。**vitest 側で条件つきスキップを書き始めたら、
//     ここを広げる**（0 件のうちは走査を増やしても守るものが無い）
//
// 使い方: node scripts/lib/scan-skip-scope.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeLine } from './stdout-sync.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** describe 直下の「条件つき」スキップ。`test.skip()` 単体（条件なし）は対象外 */
const CONDITIONAL_SKIP_RE = /^\s*test\.skip\(\s*[^)\s]/
/** 引数を取らない同期テスト。`async` が付くものは対象外（中で await できるため） */
const SYNC_TEST_RE = /^\s*(?:test|it)\(\s*(['"`]).*\1\s*,\s*\(\s*\)\s*=>/
/** 逃がす印。理由は同じ行に要る */
const EXEMPT_RE = /\/\/[ \t]*skip-scope-ok:[ \t]*\S/

export function listSpecFiles(dir, readdir = fs.readdirSync) {
  let entries
  try {
    entries = readdir(dir)
  } catch {
    return []
  }
  return entries.filter((f) => f.endsWith('.spec.ts')).sort()
}

/**
 * 1 ファイルを走査して違反を返す。
 *
 * describe の範囲は「`test.describe(` の行のインデントと同じ列で `})` が来るまで」。
 * ネストした describe はその内側なので、外側の前提も内側に効く（＝外側で見つければ足りる）。
 */
export function scanSource(source, file = '(inline)') {
  const lines = source.split('\n')
  const violations = []

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*test\.describe\(/.test(lines[i])) continue
    const indent = lines[i].match(/^\s*/)[0].length

    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^(\s*)\}\)/)
      if (m && m[1].length === indent) {
        end = j
        break
      }
    }

    const body = lines.slice(i + 1, end)
    const skips = body.filter((l) => CONDITIONAL_SKIP_RE.test(l))
    if (skips.length === 0) continue

    for (let k = 0; k < body.length; k++) {
      const line = body[k]
      if (!SYNC_TEST_RE.test(line)) continue
      // 逃がし口は同じ行か、直前の行（テスト名が長いので上に書けるようにする）
      if (EXEMPT_RE.test(line) || (k > 0 && EXEMPT_RE.test(body[k - 1]))) continue
      const name = line.trim().slice(0, 70)
      // WHY(前提を全部出す、2026-09-10): 1 つ目だけ出すと「その前提を外せば済む」と読める。
      //      実例では 2 つあり（フィクスチャと SUPABASE_SERVICE_ROLE_KEY）、
      //      **どちらか一方でもスキップになる**。直す人は全部を見ないと判断できない。
      const conditions = skips.map((s) => s.trim().replace(/^test\.skip\(\s*/, '').slice(0, 60))
      violations.push(
        `skip-scope: ${file} — 前提 ${skips.length} 件（${conditions.join(' / ')}）が ` +
          `同期テスト「${name}」にも効いている。この検査は await できない＝DB もブラウザも要らないので、` +
          '前提の要らない場所（npm test 等）へ移すか、「// skip-scope-ok: 理由」を書く'
      )
    }
  }

  return violations
}

export function scan(dir, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const files = listSpecFiles(dir)
  const violations = []
  let describes = 0
  let conditionalSkips = 0

  for (const f of files) {
    const source = readFile(path.join(dir, f))
    describes += (source.match(/^\s*test\.describe\(/gm) ?? []).length
    conditionalSkips += (source.match(/^\s*test\.skip\(\s*[^)\s]/gm) ?? []).length
    violations.push(...scanSource(source, f))
  }

  return { files: files.length, describes, conditionalSkips, violations }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.SKIP_SCOPE_SCAN_DIR ?? path.join(REPO_ROOT, 'e2e')
  const { files, describes, conditionalSkips, violations } = scan(dir)

  // fail-open 防止 1: spec を 1 本も見つけられなければ、違反 0 は「合格」ではなく「探せていない」
  if (files === 0) {
    console.error('scan-skip-scope: spec を 1 本も見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: 条件つきスキップがどこにも無いのも、探し方が変わった合図
  //   （このリポジトリには実在する。本当に 0 件なら環境変数で明示する）
  if (conditionalSkips === 0 && !process.env.SKIP_SCOPE_ALLOW_ZERO) {
    console.error(
      'scan-skip-scope: 条件つきの test.skip が 1 つも無い（走査が壊れている疑い）。' +
        '本当に 0 件なら SKIP_SCOPE_ALLOW_ZERO=1 を付ける'
    )
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    writeLine(`  spec=${files} describe=${describes} 条件つき skip=${conditionalSkips}`)
  }
  for (const v of violations) writeLine(v)
  writeLine(`specs=${files} describes=${describes} conditional-skips=${conditionalSkips} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
