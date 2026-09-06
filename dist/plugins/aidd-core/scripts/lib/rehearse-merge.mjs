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
// 終了コード: 衝突が 1 件でもあれば 1（CI で使えるように）。

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

function parseArgs(argv) {
  const o = { base: 'origin/main', json: false, repo: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') o.base = argv[++i]
    else if (a === '--branches') o.branches = argv[++i]
    else if (a === '--queue') o.queue = argv[++i]
    else if (a === '--repo') o.repo = argv[++i]
    else if (a === '--json') o.json = true
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

let base = git(['rev-parse', o.base])
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
  console.log(JSON.stringify({ base: o.base, results, conflictCount: conflicts.length }, null, 2))
} else {
  console.log(`起点: ${o.base} = ${git(['rev-parse', '--short', o.base])}`)
  console.log('')
  for (const r of results) {
    if (r.status === 'ok') console.log(`OK      ${r.label}`)
    else if (r.status === 'already') console.log(`済み    ${r.label}（すでに積まれている）`)
    else if (r.status === 'missing') console.log(`無し    ${r.label}（${r.branch} が無い）`)
    else {
      console.log(`衝突    ${r.label}（${r.branch}）`)
      for (const f of r.files) console.log(`          ${f}`)
    }
  }
  console.log('')
  console.log(`--- 衝突 ${conflicts.length} 件 / ${results.length} 本 ---`)
  if (conflicts.length > 0) {
    const byFile = {}
    for (const c of conflicts) for (const f of c.files) (byFile[f] ??= []).push(c.label)
    console.log('衝突したファイル（多い順）:')
    for (const [f, labels] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${f}: ${labels.length} 本（${labels.join(' / ')}）`)
    }
  }
  console.log('※ 作業ツリーとブランチには触れていない（merge-tree と commit-tree だけを使う）')
}

process.exit(conflicts.length > 0 ? 1 : 0)
