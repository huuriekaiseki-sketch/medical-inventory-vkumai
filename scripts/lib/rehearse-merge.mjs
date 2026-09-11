#!/usr/bin/env node
// 複数のブランチを「この順で main へ入れたら衝突するか」を、作業ツリーを触らずに調べる。
//
// WHY: 2026-09-06〜07 に GitHub のアカウント停止で PR が出せず、ローカルに 22 本のブランチが
//      溜まった。復旧後にまとめてマージする段になって初めて衝突が分かると、
//      「どれを先に入れるか」「どこを直すか」を大量に同時に判断することになる。
//      衝突は**今**分かるので、今のうちに知っておく。
//
//      checkout も merge もしない（git merge-tree で木だけを計算し、成功したら commit-tree で
//      仮コミットを作って次を積む）。いま開いている作業ツリー・ブランチには一切影響しない。
//
// 使い方:
//   node scripts/lib/rehearse-merge.mjs --base origin/main --branches a,b,c
//   node scripts/lib/rehearse-merge.mjs --base origin/main --queue scripts/lib/merge-queue.json
//   （--json で機械可読な出力）
//
// 出力: 各ブランチの OK / 衝突 / 済み と、衝突したファイルの一覧。
//       衝突したブランチは積まずに次へ進む（後続の判定を実態に近づけるため）。
// 終了コード: 0 = 衝突なし / 1 = 衝突あり / 2 = 使い方が違う / 3 = **起点が遅れていて判定できない**
//
// WHY(起点の遅れを合否に混ぜない、2026-09-10): 既定の起点は `origin/main`。
//      2026-09-06 の GitHub アカウント停止以降 `origin/main` は凍ったままで、
//      実際に積む先（gitlab へ push している `main`）だけが進んでいた。
//      その状態でこの道具を回すと **実在しない衝突 10 件** が出る（2026-09-10 実測。
//      実際の main を起点にすると 37 本すべて「すでに積まれている」で衝突 0 件だった）。
//      これは「衝突している」でも「衝突していない」でもなく、
//      **誰も聞いていない問いに答えている**状態なので、合否に混ぜず 3 で止める（C-025）。
//      遅れた起点で敢えて測りたいときは --allow-stale-base。

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { writeLine } from './stdout-sync.mjs'

function parseArgs(argv) {
  const o = { base: 'origin/main', json: false, repo: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') o.base = argv[++i]
    else if (a === '--branches') o.branches = argv[++i]
    else if (a === '--queue') o.queue = argv[++i]
    else if (a === '--repo') o.repo = argv[++i]
    else if (a === '--json') o.json = true
    else if (a === '--allow-stale-base') o.allowStaleBase = true
  }
  return o
}

const o = parseArgs(process.argv.slice(2))
const git = (args) => execFileSync('git', ['-C', o.repo, ...args], { encoding: 'utf8' }).trim()
const tryGit = (args) => {
  try { return { ok: true, out: execFileSync('git', ['-C', o.repo, ...args], { encoding: 'utf8' }) } }
  catch (e) { return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') } }
}

let queue = []
if (o.queue) {
  if (!existsSync(o.queue)) {
    console.error(`rehearse-merge: 順番のファイルが無い: ${o.queue}`)
    process.exit(2)
  }
  const j = JSON.parse(readFileSync(o.queue, 'utf8'))
  queue = (j.queue ?? []).map((e) => (typeof e === 'string' ? { label: e, branch: e } : e))
} else if (o.branches) {
  queue = o.branches.split(',').map((b) => ({ label: b.trim(), branch: b.trim() }))
} else {
  console.error('rehearse-merge: --branches か --queue が要る')
  process.exit(2)
}

// WHY(空を合格と読まない、2026-09-10): 順番が空でもそのまま進むと
//      「衝突 0 件 / 0 本」で**終了コード 0**になる。測る対象が 1 本も無いことと
//      「調べたら衝突が無かった」ことは別なので、分けて落とす（C-021: 走査の空振り）。
if (queue.length === 0) {
  console.error('rehearse-merge: 順番が空です（測る対象が 1 本も無い）。0 件を合格と読まないため落とします')
  process.exit(2)
}

let base = git(['rev-parse', o.base])

/**
 * 起点が「実際に積む先」より遅れていないかを見る。
 * 遅れていれば {ahead, baseShort, mainShort} を返し、そうでなければ null。
 */
export function staleBaseOf({ baseSha, mainSha, ahead }) {
  if (!mainSha || mainSha === baseSha) return null
  if (!(ahead > 0)) return null
  return { ahead, base: baseSha.slice(0, 8), main: mainSha.slice(0, 8) }
}

const mainProbe = tryGit(['rev-parse', '--verify', '--quiet', 'main'])
const mainSha = mainProbe.ok ? mainProbe.out.trim() : ''
const aheadProbe = mainSha ? tryGit(['rev-list', '--count', `${base}..${mainSha}`]) : { ok: false, out: '' }
const staleBase = staleBaseOf({
  baseSha: base,
  mainSha,
  ahead: aheadProbe.ok ? Number.parseInt(aheadProbe.out.trim(), 10) : 0,
})

if (staleBase && !o.allowStaleBase) {
  if (o.json) {
    writeLine(JSON.stringify({ base: o.base, measured: false, staleBase }, null, 2))
  } else {
    console.error('rehearse-merge: 起点が遅れています（判定できません）')
    console.error(`  起点 ${o.base} = ${staleBase.base}`)
    console.error(`  いまの main   = ${staleBase.main}（起点に無いコミット ${staleBase.ahead} 件）`)
    console.error('  この起点で測ると、**実際には存在しない衝突**が出ます')
    console.error('  実際に積む先を指定してください: bash scripts/rehearse-merge.sh --base main')
    console.error('  遅れた起点で敢えて測るなら --allow-stale-base')
  }
  process.exit(3)
}

const results = []

for (const { label, branch } of queue) {
  const head = tryGit(['rev-parse', '--verify', branch])
  if (!head.ok) {
    results.push({ label, branch, status: 'missing' })
    continue
  }
  const sha = head.out.trim()
  if (tryGit(['merge-base', '--is-ancestor', sha, base]).ok) {
    results.push({ label, branch, status: 'already' })
    continue
  }
  const merged = tryGit(['merge-tree', '--write-tree', '--name-only', base, sha])
  if (!merged.ok) {
    // 出力は「tree oid / 衝突ファイル / 空行 / 説明」の順。ファイル名だけを拾う
    const lines = merged.out.split('\n').map((l) => l.trim()).filter(Boolean)
    const files = []
    for (const l of lines.slice(1)) {
      if (l.startsWith('Auto-merging') || l.startsWith('CONFLICT') || /^\d+$/.test(l)) continue
      if (l.includes(' ')) continue
      files.push(l)
    }
    results.push({ label, branch, status: 'conflict', files: [...new Set(files)] })
    continue
  }
  const tree = merged.out.split('\n')[0].trim()
  base = git(['commit-tree', tree, '-p', base, '-p', sha, '-m', `rehearse: ${label}`])
  results.push({ label, branch, status: 'ok' })
}

const conflicts = results.filter((r) => r.status === 'conflict')

if (o.json) {
  writeLine(JSON.stringify({ base: o.base, results, conflictCount: conflicts.length }, null, 2))
} else {
  writeLine(`起点: ${o.base} = ${git(['rev-parse', '--short', o.base])}`)
  writeLine('')
  for (const r of results) {
    if (r.status === 'ok') writeLine(`OK      ${r.label}`)
    else if (r.status === 'already') writeLine(`済み    ${r.label}（すでに積まれている）`)
    else if (r.status === 'missing') writeLine(`無し    ${r.label}（${r.branch} が無い）`)
    else {
      writeLine(`衝突    ${r.label}（${r.branch}）`)
      for (const f of r.files) writeLine(`          ${f}`)
    }
  }
  writeLine('')
  writeLine(`--- 衝突 ${conflicts.length} 件 / ${results.length} 本 ---`)
  if (conflicts.length > 0) {
    const byFile = {}
    for (const c of conflicts) for (const f of c.files) (byFile[f] ??= []).push(c.label)
    writeLine('衝突したファイル（多い順）:')
    for (const [f, labels] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
      writeLine(`  ${f}: ${labels.length} 本（${labels.join(' / ')}）`)
    }
  }
  writeLine('※ 作業ツリーとブランチには触れていない（merge-tree と commit-tree だけを使う）')
}

process.exit(conflicts.length > 0 ? 1 : 0)
