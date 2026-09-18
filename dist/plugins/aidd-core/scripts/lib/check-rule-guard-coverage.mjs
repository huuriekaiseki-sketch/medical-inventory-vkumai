#!/usr/bin/env node
// WHY: 2026-09-07。common.md を圧縮して「常時ロードされない場所」へ出すたびに、
//      **そのルールが読まれなくなるリスク**を負う。読まれないルールは守られない。
//
//      これまでの検査は片方向だった:
//        `scripts/check-hook-doc-pointers.test.sh` … **検査 → ルール**（検査が指す節が実在するか）
//      逆方向、つまり **ルール → 検査**（この節を守る検査があるか）は誰も見ていなかった。
//      そのため「ルールを外に出す」判断が、毎回その場の human judgment に委ねられていた。
//
//      ここで逆方向を機械にする。**ルールの節は次のどちらかでなければならない**:
//        (1) どこかの検査（scripts/** / .claude/workflows/**）が `<file>.md「<節名>」` で名指ししている
//        (2) `docs/agents/undetectable-rules-inventory.md` に「検知手段が無い」と登録されている
//      どちらでもない節は**穴**として落とす。第三の道（黙って検知の無いルールを増やす）を残さない。
//
//      これは docs/agents/decisions.md「なぜ新しい運用ルールに『検知手段を先に決める』原則を
//      導入したか（issue #339）」を、文書での約束から機械検査へ移すもの。
//
// 既知の限界:
//   - **名指ししているだけで、本当に守っているかは見ていない。** 検査の中で節名を文字列として
//     書けば「守っている」と数える。中身が対応しているかは人が読むしかない。
//     この穴のうち「テストが検査の**存在**しか見ていない」形は
//     `scripts/check-rule-guard-effective.test.sh` が塞ぐ（検査を no-op にして落ちるかを測る）。
//     残るのは「テストは振る舞いを見ているが、見ている振る舞いがそのルールと対応していない」形で、
//     こちらは機械では判定できない。
//   - **「検知が無いと登録した」＝守られている、ではない。** (2) は穴を可視化するだけで塞がない。
//     登録が増えるのは「機械の検査が届いていない領域が増えた」合図であって、合格ではない。
//   - **節の粒度で見るので、節の中の一部だけが守られている場合も「守」と数える。**
//     例: ブランチ運用ルールは 3 行のうち 2 行しか hook が見ていないが、ここでは 1 つの節として通る
//     （その差は undetectable-rules-inventory.md の備考が担う）。
//   - **ルールでない節（索引・参照リスト）は下の NOT_RULES に手で書く。** 足し忘れると穴として落ちるが、
//     逆に「ルールなのに NOT_RULES に入れて逃げる」ことは止められない（理由の記述だけが歯止め）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

/**
 * 導入先ごとの設定（**エンジンは共通・登録簿は導入先**。catalog-registry.json と同じ形）。
 *
 * WHY(2026-09-09 に分離): 「どの文書がルールか」「どの節はルールでないか」は
 *      リポジトリごとに違う。エンジンに直書きしていると共通側へ配れない。
 *      登録簿が無い導入先は規約の既定（docs/agents/common.md）で動くので、
 *      入れた初日から何もしなくても効く。
 */
const REGISTRY = 'scripts/lib/rule-guard-registry.json'
const DEFAULT_RULE_DOCS = ['docs/agents/common.md']

export function loadRegistry(root = process.cwd()) {
  const file = path.join(root, REGISTRY)
  if (!existsSync(file)) return { ruleDocs: DEFAULT_RULE_DOCS, notRules: {} }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const ruleDocs = Array.isArray(raw.ruleDocs) && raw.ruleDocs.length > 0 ? raw.ruleDocs : DEFAULT_RULE_DOCS
  return { ruleDocs, notRules: raw.notRules ?? {} }
}

/** 検査の名指しを探す場所 */
const SCAN_DIRS = ['scripts', '.claude/workflows', '.claude/rules', '.github/workflows']
const SCAN_EXT = ['.sh', '.mjs', '.js', '.ts', '.md', '.yml']

const UNDETECTABLE_DOC = 'docs/agents/undetectable-rules-inventory.md'


/** `<file>.md「<節名>」` / `[`x.md`](./x.md)「<節名>」` の両方から節名を取る */
const POINTER = /([A-Za-z0-9_.-]+\.md)\)?「([^」]*)」/g

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (SCAN_EXT.some((x) => p.endsWith(x))) out.push(p)
  }
  return out
}

/** 節名（`##` / `###` の見出し）。`####` 以下は節の中の小見出しなので対象にしない */
export function ruleSections(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(#{2,3}) (.+?)\s*$/)
    if (m) out.push({ level: m[1].length, title: m[2] })
  }
  return out
}

function pointedSections(text) {
  const out = new Set()
  for (const m of text.matchAll(POINTER)) out.add(m[2])
  return out
}

/** 節名が集合のどれかと前方一致で対応するか（節名に issue 番号が付く / 付かない揺れを吸収） */
function covers(set, title) {
  for (const s of set) {
    if (s === title) return true
    if (title.startsWith(s) || s.startsWith(title)) return true
  }
  return false
}

export function check(root = '.') {
  const guarded = new Set()
  for (const dir of SCAN_DIRS) {
    for (const f of walk(path.join(root, dir))) {
      let t
      try {
        t = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      for (const s of pointedSections(t)) guarded.add(s)
    }
  }

  const declared = pointedSections(readFileSync(path.join(root, UNDETECTABLE_DOC), 'utf8'))

  const violations = []
  const summary = []
  const { ruleDocs, notRules: NOT_RULES } = loadRegistry(root)
  for (const doc of ruleDocs) {
    const text = readFileSync(path.join(root, doc), 'utf8')
    const secs = ruleSections(text)
    // `##` は分野の分類、`###` がルール本体（2026-09-07 の再構成でこの形にした）
    const rules = secs.filter((s) => s.level === 3)
    for (const { title } of rules) {
      if (title in NOT_RULES) {
        summary.push({ doc, title, state: '対象外' })
        continue
      }
      if (covers(guarded, title)) {
        summary.push({ doc, title, state: '守' })
      } else if (covers(declared, title)) {
        summary.push({ doc, title, state: '宣' })
      } else {
        summary.push({ doc, title, state: '穴' })
        violations.push({ doc, title })
      }
    }
  }
  return { violations, summary }
}

if (process.argv[1] && process.argv[1].endsWith('check-rule-guard-coverage.mjs')) {
  const root = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? '.'
  const verbose = process.argv.includes('--verbose')
  const { violations, summary } = check(root)

  if (verbose) {
    for (const s of summary) writeLine(`  [${s.state}] ${s.doc} 「${s.title}」`)
    writeLine('')
  }

  for (const v of violations) {
    console.error(`NG ${v.doc}「${v.title}」を守る検査がありません`)
  }
  if (violations.length > 0) {
    console.error('')
    console.error('ルールの節は、次のどちらかでなければなりません:')
    console.error('  (1) 検査が `<file>.md「<節名>」` で名指しする（守る側から辿れるようにする）')
    console.error(`  (2) ${UNDETECTABLE_DOC} に「検知手段が無い」と登録する（穴を可視化する）`)
    console.error('ルールではない節（索引・参照リスト）なら、理由つきで NOT_RULES に足してください。')
    process.exit(1)
  }
  const counts = summary.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] ?? 0) + 1 }), {})
  writeLine(`checked=${summary.length} 守=${counts['守'] ?? 0} 宣=${counts['宣'] ?? 0} 対象外=${counts['対象外'] ?? 0} violations=0`)
}
