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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** ルールが書かれている、常時ロードされる文書 */
export const RULE_DOCS = ['docs/agents/common.md']

/** 検査の名指しを探す場所 */
const SCAN_DIRS = ['scripts', '.claude/workflows', '.claude/rules', '.github/workflows']
const SCAN_EXT = ['.sh', '.mjs', '.js', '.ts', '.md', '.yml']

const INVENTORY = 'docs/agents/undetectable-rules-inventory.md'

/**
 * ルールではない節（分類の見出し・索引・参照リスト）と、その理由。
 * 「面倒だから」で足さない。ここに入れたものは検査の対象外になる。
 */
export const NOT_RULES = {
  'どこに何があるか（索引）': 'ルールではなく file-index.md へのポインタ',
  '分離した参照ドキュメント': 'ルールではなく分離先の一覧',
  'Next.js バージョンに関する注意': 'ルールではなく前提の共有（node_modules の docs を読め、という指示で、守ったか破ったかを判定する対象が無い）',
}

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

  const declared = pointedSections(readFileSync(path.join(root, INVENTORY), 'utf8'))

  const violations = []
  const summary = []
  for (const doc of RULE_DOCS) {
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
    for (const s of summary) console.log(`  [${s.state}] ${s.doc} 「${s.title}」`)
    console.log('')
  }

  for (const v of violations) {
    console.error(`NG ${v.doc}「${v.title}」を守る検査がありません`)
  }
  if (violations.length > 0) {
    console.error('')
    console.error('ルールの節は、次のどちらかでなければなりません:')
    console.error('  (1) 検査が `<file>.md「<節名>」` で名指しする（守る側から辿れるようにする）')
    console.error(`  (2) ${INVENTORY} に「検知手段が無い」と登録する（穴を可視化する）`)
    console.error('ルールではない節（索引・参照リスト）なら、理由つきで NOT_RULES に足してください。')
    process.exit(1)
  }
  const counts = summary.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] ?? 0) + 1 }), {})
  console.log(`checked=${summary.length} 守=${counts['守'] ?? 0} 宣=${counts['宣'] ?? 0} 対象外=${counts['対象外'] ?? 0} violations=0`)
}
