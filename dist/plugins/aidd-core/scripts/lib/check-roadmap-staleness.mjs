#!/usr/bin/env node
// WHY: 2026-09-07。ロードマップの状態列が実態より古くなっていた。
//      実際には仕組みが入って測れているのに「計画」のままの行が 3 つあり、
//      その成果物（設定ファイル・棚卸しの文書）はどれも既に存在していた。
//
//      **古い「計画」は「まだやっていない」と誤読させる。** 着手先を選ぶときに間違える。
//      同じ日に、常時ロードされる文書でも同型の事故が出ている
//      （説明が分離先の訂正に追従せず、古いまま読まれ続けていた）。
//
//      ここでは「`計画 #757-N` と書いてある行について、その N の成果物が既に在るか」を見る。
//      在るなら状態を見直す合図。**自動では直さない**（何が終わって何が残るかは人が決める）。
//
// 既知の限界:
//   - **成果物の対応表（EVIDENCE）は手で書く。** 番号を足したらここにも足す。足し忘れは
//     「対応を定義していない」として黙って通る（`--verbose` でだけ見える）。
//   - **ファイルが在る ＝ 終わっている、ではない。** 途中まで作って止めた場合も在ると数える。
//     だからこの検査は**落とさない**（警告して人に見せるだけ）。落とすと「消せば通る」になる。
//   - 逆（実装が消えたのに「実装済み」のまま）は見ていない。パスの実在は
//     `check-docs-integrity.mjs` が別途見る。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ロードマップの文書・番号の書き方・成果物の対応は導入先ごとに違う
 * （**エンジンは共通・登録簿は導入先**）。
 *
 * WHY(2026-09-09 に分離): 「状態列と成果物を突き合わせる」型はどのリポジトリでも同じで、
 *      固有なのは対象の文書と番号の対応だけだった。エンジンに直書きしていると共通側へ配れない。
 *      登録簿を置いていない導入先では飛ばす（ロードマップの持ち方は導入先ごとに違う）。
 */
const REGISTRY = 'scripts/lib/roadmap-registry.json'

export function loadRegistry(root = '.') {
  const file = path.join(root, REGISTRY)
  if (!existsSync(file)) return null
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw.catalog || !raw.planPattern) return null
  return { catalog: raw.catalog, planPattern: new RegExp(raw.planPattern), evidence: raw.evidence ?? {} }
}

export function check(root = '.') {
  const registry = loadRegistry(root)
  if (!registry) return { stale: [], undefined: [], catalog: null, skipped: true }
  const { catalog: CATALOG, planPattern, evidence: EVIDENCE } = registry
  const text = readFileSync(path.join(root, CATALOG), 'utf8')
  const stale = []
  const undefined_ = []

  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = line.match(planPattern)
    if (!m) continue
    const n = Number(m[1])
    const title = line.split('|')[1]?.trim() ?? ''
    const ev = EVIDENCE[n]
    if (!ev) {
      undefined_.push({ n, title })
      continue
    }
    const found = ev.filter((f) => existsSync(path.join(root, f)))
    if (found.length > 0) stale.push({ n, title, found })
  }
  return { stale, undefined: undefined_, catalog: CATALOG, skipped: false }
}

if (process.argv[1] && process.argv[1].endsWith('check-roadmap-staleness.mjs')) {
  const root = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? '.'
  const verbose = process.argv.includes('--verbose')
  const { stale, undefined: undef, catalog, skipped } = check(root)

  if (skipped) {
    console.log('scripts/lib/roadmap-registry.json が無いので飛ばしました（ロードマップの持ち方は導入先ごとに違う）。')
    process.exit(0)
  }

  for (const s of stale) {
    console.log(`要見直し 計画 ${s.n}「${s.title}」は「計画」のままですが、成果物が在ります:`)
    for (const f of s.found) console.log(`    ${f}`)
  }
  if (verbose) {
    for (const u of undef) {
      console.log(`(対応を定義していない) 計画 ${u.n}「${u.title}」`)
    }
  }
  if (stale.length === 0) {
    console.log(`checked=${catalog} 要見直し=0`)
  } else {
    console.log('')
    console.log('状態列を実態に合わせてください。**何が終わって何が残るかは人が決める**ので、')
    console.log('この検査は落としません（落とすと「成果物を消せば通る」になるため）。')
  }
  // warning-only: 常に 0 で終わる
  process.exit(0)
}
