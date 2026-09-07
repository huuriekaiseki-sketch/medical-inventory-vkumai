#!/usr/bin/env node
// WHY: 2026-09-07。`security-test-catalog.md` の状態列が実態より古くなっていた。
//      「ミューテーションテスト」は `計画 #757-7` のままだったが、実際は Stryker が入って
//      95.80% まで測れており、`stryker.config.json` も `mutation-testing.md` も存在していた。
//      同様に #757-32（悪用耐性）は `quota-inventory.md` に Q-001〜Q-031 が棚卸し済み、
//      #757-39（内部不正）は監査ログと拒否の記録が入っていたのに、どれも「計画」のままだった。
//
//      **古い「計画」は「まだやっていない」と誤読させる。** 着手先を選ぶときに間違える。
//      同じ日に common.md でも同型の事故が出ている（TRI/RISK 第 5 カテゴリの説明が、
//      decisions/aidd-pipeline.md の訂正に追従せず古いまま常時ロードされていた）。
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

export const CATALOG = 'docs/agents/security-test-catalog.md'

/**
 * #757 の番号 → その番号が終わっていれば在るはずの成果物。
 * 「在れば終わり」ではなく「在るなら状態を見直せ」の意味。
 */
export const EVIDENCE = {
  5: ['src/lib/log-safe.ts', 'docs/agents/data-lifecycle-inventory.md'],
  6: ['docs/agents/property-testing.md'],
  7: ['stryker.config.json', 'docs/agents/mutation-testing.md'],
  8: ['docs/agents/monitoring.md'],
  11: ['docs/agents/restore-drill.md'],
  23: ['docs/agents/restore-drill.md'],
  24: ['docs/agents/privileged-write-rulebook.md'],
  28: ['docs/agents/data-lifecycle-inventory.md'],
  29: ['docs/agents/key-rotation-runbook.md'],
  32: ['docs/agents/quota-inventory.md'],
  35: ['docs/agents/config-drift.md'],
  39: ['docs/agents/threat-model.md'],
}

export function check(root = '.') {
  const text = readFileSync(path.join(root, CATALOG), 'utf8')
  const stale = []
  const undefined_ = []

  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const m = line.match(/計画 #757-([0-9]+)/)
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
  return { stale, undefined: undefined_ }
}

if (process.argv[1] && process.argv[1].endsWith('check-roadmap-staleness.mjs')) {
  const root = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? '.'
  const verbose = process.argv.includes('--verbose')
  const { stale, undefined: undef } = check(root)

  for (const s of stale) {
    console.log(`要見直し #757-${s.n}「${s.title}」は「計画」のままですが、成果物が在ります:`)
    for (const f of s.found) console.log(`    ${f}`)
  }
  if (verbose) {
    for (const u of undef) {
      console.log(`(対応を定義していない) #757-${u.n}「${u.title}」`)
    }
  }
  if (stale.length === 0) {
    console.log(`checked=${CATALOG} 要見直し=0`)
  } else {
    console.log('')
    console.log('状態列を実態に合わせてください。**何が終わって何が残るかは人が決める**ので、')
    console.log('この検査は落としません（落とすと「成果物を消せば通る」になるため）。')
  }
  // warning-only: 常に 0 で終わる
  process.exit(0)
}
