#!/usr/bin/env node
// 変更されたパスの一覧から、「コード側のジョブ（型検査・lint・build・依存監査）を回す要があるか」を決める。
//
// WHY(2026-09-18、issue #783): ci.yml は `paths-ignore: docs/**` を持っていたので、**docs だけを
//      変えた PR では CI が 1 ジョブも起動しなかった**。ところが docs を読む検査は多数ある
//      （hooks-test の check-catalogs・check-session-handoff-format 等に加え、vitest 側も
//      escaped-defects / privileged-writes / table_registry / role_registry が docs をルールブックとして
//      **実際に読む**）。結果、PR #781（docs のみ）が違反 2 件を main へ通した。検査は在ったが
//      **起動しなかった**——「検査があっても起動しなければ無いのと同じ」の実例。
//
//      workflow 全体を止める paths-ignore では「この PR ではどのジョブが要るか」を表現できないので、
//      判定をここへ出し、ci.yml は job の `if:` で分ける。docs を見るジョブ（test / hooks-test）は
//      **無条件に回す**ので、この判定は「重いジョブを省いてよいか」だけを答える。
//
// 使い方:
//   git diff --name-only <base>...<head> | node scripts/lib/classify-changed-paths.mjs
//   node scripts/lib/classify-changed-paths.mjs --files <一覧ファイル>
// 出力: `code=true` / `code=false` の 1 行（GitHub Actions の出力にそのまま流せる形）と、判断の理由。
// 終了コード: 常に 0（判定できないときは code=true に倒すので、失敗で止める意味が無い）
//
// 限界:
//   - **判定できないときは必ず code=true**（全部回す）。一覧が空・読めない・想定外の形は
//     「コードに触れていない」ではなく「分からない」なので、安全側の全実行に倒す（C-025）
//   - 除外は前方一致と完全一致だけ。glob は解釈しない（`docs/**` は前方一致 `docs/` として扱う）
//   - **「この一覧に足せばジョブが減る」ことは、その分だけ検査が減ることを意味する。**
//     足すときは「そのパスを読む検査・テストが 1 つも無い」ことを確かめてから足す
import { readFileSync } from 'node:fs'
import { writeLine } from './stdout-sync.mjs'

/**
 * これ**しか**変わっていなければ、コード側のジョブ（型検査・lint・build・依存監査）は要らない。
 * test / hooks-test はここに関係なく常に回るので、docs を見る検査はどれも死なない。
 */
export const CODE_IRRELEVANT = [
  { kind: 'prefix', value: 'docs/', why: 'ルールブック・台帳。型も lint もビルドも通らない' },
  { kind: 'prefix', value: '.claude/skills/', why: 'スキルの本文。実行されるコードではない' },
  { kind: 'prefix', value: '.claude/rules/', why: 'path-scoped rules の本文' },
  { kind: 'exact', value: 'CLAUDE.md', why: 'エージェントへの指示' },
  { kind: 'exact', value: 'AGENTS.md', why: '同上' },
  { kind: 'exact', value: 'README.md', why: 'リポジトリの説明' },
]

const matches = (rel) =>
  CODE_IRRELEVANT.some((r) => (r.kind === 'prefix' ? rel.startsWith(r.value) : rel === r.value))

/**
 * @param {string[]} paths 変更されたパス（リポジトリ相対）
 * @returns {{ code: boolean, reason: string, relevant: string[] }}
 */
export function classify(paths) {
  const list = (paths ?? []).map((p) => String(p).trim()).filter(Boolean)
  // WHY(C-025): 空は「コードに触れていない」ではなく「分からない」。base が取れていない・
  //      diff に失敗した、のどちらでも空になるので、静かに全ジョブを省くほうが危ない。
  if (list.length === 0) {
    return { code: true, reason: '変更されたパスを 1 件も読めなかった（判定できないので全部回す）', relevant: [] }
  }
  const relevant = list.filter((p) => !matches(p))
  if (relevant.length === 0) {
    return { code: false, reason: `${list.length} 件すべてがコードに触れないパス`, relevant: [] }
  }
  return { code: true, reason: `コードに触れるパスが ${relevant.length} 件`, relevant }
}

function readInput() {
  const i = process.argv.indexOf('--files')
  if (i >= 0 && process.argv[i + 1]) return readFileSync(process.argv[i + 1], 'utf8')
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

if (process.argv[1] && process.argv[1].endsWith('classify-changed-paths.mjs')) {
  let r
  try {
    r = classify(readInput().split('\n'))
  } catch (e) {
    // WHY: ここで落ちて「ジョブが起動しない」のが最悪なので、読めなかったら全部回す
    r = { code: true, reason: `判定に失敗した（${e.message}）ので全部回す`, relevant: [] }
  }
  writeLine(`code=${r.code}`)
  writeLine(`reason=${r.reason}`)
  for (const p of r.relevant.slice(0, 20)) writeLine(`relevant=${p}`)
  process.exit(0)
}
