#!/usr/bin/env node
// ハーネスの地図（docs/agents/harness-map.md）の表を、登録簿と**台帳の実物**から生成する。
//
// WHY(2026-09-10): 地図の状態と借金の数字を手で書いていた。手で書いた数字は必ず古くなる——
//      実際に 2026-09-09、同じ日に**台帳の数字を 2 回取り違えた**（別の台帳の数を足した／
//      数える単位を取り違えた）。数字は台帳の実物から読み、表は生成物にする。
//
//      あわせて、宣言したもの（入口・検査・限界を書いた文書）が**実在するか**も見る。
//      「地図に書いてあるのに無い」は、事故のときに最初に開く 1 枚として最悪の外れ方。
//
// WHY(全部を生成しない): この文書には読み方・限界・更新の引き金といった散文がある。
//      生成するのは**表だけ**にして、印（generated:<名前>）で挟んだ範囲を差し替える。
//
// 使い方:
//   node scripts/lib/render-harness-map.mjs <registry.json> --root <repo> [--check]
//
// --check: 書き込まず、いまの文書が生成物と一致するかだけ見る（一致すれば exit 0、違えば 1）

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** `a.b.length` のような単純な道をたどる。配列には `.length` だけ許す */
export function resolvePath(obj, dotted) {
  let cur = obj
  for (const key of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (key === 'length') {
      cur = Array.isArray(cur) ? cur.length : undefined
      continue
    }
    cur = cur[key]
  }
  return cur
}

/**
 * リポジトリにある検査スクリプトを全部数える（`scripts/*.test.sh` と `scripts/lib/*.test.sh`）。
 *
 * WHY(hooks-test が回すのと同じ集合にする): CI の hooks-test は この 2 つの glob を回す。
 *      違う集合を数えると「地図には載っているが誰も回していない」検査が生まれる。
 */
export function listCheckScripts(root, readdir = readdirSync) {
  const out = []
  for (const dir of ['scripts', 'scripts/lib']) {
    let names
    try {
      names = readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const n of names) {
      if (typeof n === 'string' && n.endsWith('.test.sh')) out.push(`${dir}/${n}`)
    }
  }
  return out.sort()
}

/**
 * 登録簿の宣言が実物と食い違っていないかを見る。
 *
 * 返すのは違反の一覧（空なら健全）。**空振りを避けるため、0 件のときは登録簿が
 * 読めていない可能性を別に見る**（呼び出し側が harnesses.length を確かめる）。
 */
export function checkRegistry({
  registry,
  root,
  exists = (p) => existsSync(p),
  listChecks = (r) => listCheckScripts(r),
}) {
  const violations = []
  const triggers = Object.keys(registry.triggers ?? {})
  const states = ['あり', '一部', '外部待ち']
  const seen = new Set()
  /** 検査 → それを持つハーネス。同じ検査を 2 か所に置かせない */
  const checkOwner = new Map()

  for (const h of registry.harnesses ?? []) {
    const at = `${h.id} ${h.role}`
    if (seen.has(h.id)) violations.push(`duplicate-id: ${at}`)
    seen.add(h.id)
    if (!triggers.includes(h.trigger)) {
      violations.push(`unknown-trigger: ${at} は「${h.trigger}」（使えるのは ${triggers.join(' / ')}）`)
    }
    if (!states.includes(h.state)) {
      violations.push(`unknown-state: ${at} は「${h.state}」（使えるのは ${states.join(' / ')}）`)
    }
    // 宣言したファイルが実在するか。**入口はパッケージ実行系のコマンドも許す**ので、
    // パスに見えるもの（`/` を含む）だけを見る
    for (const e of h.entrypoints ?? []) {
      const file = e.replace(/^(bash|node|npx)\s+/, '').split(' ')[0]
      if (!file.includes('/')) continue
      if (!exists(path.join(root, file))) violations.push(`missing-entrypoint: ${at} → ${file}`)
    }
    for (const c of h.checks ?? []) {
      if (!exists(path.join(root, c))) violations.push(`missing-check: ${at} → ${c}`)
      // 同じ検査を 2 か所に置かせない（どの役割が守るのかが決まらなくなる）
      const owner = checkOwner.get(c)
      if (owner) violations.push(`duplicate-check: ${c} が ${owner} と ${h.id} の両方にある`)
      else checkOwner.set(c, h.id)
    }
    if (!h.limitsDoc || !exists(path.join(root, h.limitsDoc))) {
      violations.push(`missing-limits-doc: ${at} → ${h.limitsDoc ?? '(宣言なし)'}`)
    }
    if ((h.checks ?? []).length === 0) {
      // 検査を 1 つも持たないハーネスは「あると言っているだけ」
      violations.push(`no-checks: ${at}（守っていることを測る検査が 1 つも無い）`)
    }
    for (const l of h.ledgers ?? []) {
      const abs = path.join(root, l.file)
      if (!exists(abs)) {
        violations.push(`missing-ledger: ${at} → ${l.file}`)
        continue
      }
      let value
      try {
        value = resolvePath(JSON.parse(readFileSync(abs, 'utf8')), l.path)
      } catch (e) {
        violations.push(`unreadable-ledger: ${at} → ${l.file} (${e.message})`)
        continue
      }
      if (typeof value !== 'number') {
        violations.push(`ledger-not-a-number: ${at} → ${l.file}#${l.path} は ${JSON.stringify(value)}`)
      }
    }
  }

  // WHY(逆向きの ratchet、2026-09-10): 宣言した検査が実在するかは上で見ているが、
  //      **実在する検査が全部どこかのハーネスに属するか**は見ていなかった。
  //      それだと「新しい検査を足したのに地図に載らない」＝**役割の分からない検査**が静かに増える。
  //      新しい検査を足した人に「これはどの役割を守るのか」を 1 回決めさせる。
  const declared = new Set(checkOwner.keys())
  const actual = listChecks(root)
  // 空振り防止: 1 本も見つからないなら走査が壊れている（違反 0 件で通してはいけない）
  if (actual.length === 0) {
    violations.push('no-check-scripts: 検査スクリプトを 1 本も見つけられない（走査が壊れている疑い）')
  }
  for (const c of actual) {
    if (!declared.has(c)) violations.push(`unassigned-check: ${c} がどのハーネスにも属していない`)
  }
  return violations
}

/** 台帳の現在値を読む（違反は checkRegistry が見る。ここは読めた値だけを返す） */
function ledgerValue(root, ledger) {
  try {
    const v = resolvePath(JSON.parse(readFileSync(path.join(root, ledger.file), 'utf8')), ledger.path)
    return typeof v === 'number' ? String(v) : '（読めない）'
  } catch {
    return '（読めない）'
  }
}

const cell = (s) => String(s ?? '').replace(/\|/g, '／')

export function renderTables({ registry, root }) {
  const lines = []
  lines.push('| 役割 | 何を守るか | 起動 | 入口 | 検査 | 状態 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const h of registry.harnesses ?? []) {
    const entry = (h.entrypoints ?? []).map((e) => `\`${e}\``).join('<br>')
    lines.push(
      `| ${cell(h.role)}（${h.id}） | ${cell(h.guards)} | **${cell(h.trigger)}**（${cell(h.triggerDetail)}） | ${entry} | ${(h.checks ?? []).length} 本 | ${cell(h.state)} |`,
    )
  }
  lines.push('')
  lines.push('**台帳（数字はここから読む。足し算しない）**')
  lines.push('')
  lines.push('| 台帳 | 何を数えているか | 単位 | いま |')
  lines.push('| --- | --- | --- | --- |')
  const ledgers = (registry.harnesses ?? []).flatMap((h) => (h.ledgers ?? []).map((l) => ({ h, l })))
  for (const { h, l } of ledgers) {
    lines.push(
      `| \`${path.posix.basename(l.file)}\`#${cell(l.path)} | ${cell(l.name)}（${h.id}） | ${cell(l.unit)} | **${ledgerValue(root, l)}** |`,
    )
  }
  lines.push('')
  const checkTotal = (registry.harnesses ?? []).reduce((n, h) => n + (h.checks ?? []).length, 0)
  lines.push(
    `（ハーネス ${(registry.harnesses ?? []).length} 件・検査 ${checkTotal} 本・台帳 ${ledgers.length} 件。` +
      `**検査はこの表で全数**——どこにも属さない検査があれば生成そのものが落ちる）`,
  )
  return lines.join('\n')
}

/** 印で挟まれた範囲を差し替える。印が無ければ null（呼び出し側が落とす） */
export function replaceBlock(text, marker, body) {
  const start = `<!-- generated:${marker} start -->`
  const end = `<!-- generated:${marker} end -->`
  const s = text.indexOf(start)
  const e = text.indexOf(end)
  if (s === -1 || e === -1 || e < s) return null
  return text.slice(0, s + start.length) + '\n\n' + body + '\n\n' + text.slice(e)
}

function main(argv) {
  const o = { root: process.cwd(), check: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.root = argv[++i]
    else if (argv[i] === '--check') o.check = true
    else o.registry = argv[i]
  }
  if (!o.registry) {
    console.error('使い方: node scripts/lib/render-harness-map.mjs <registry.json> --root <repo> [--check]')
    process.exit(2)
  }
  const registry = JSON.parse(readFileSync(o.registry, 'utf8'))

  // 空振り防止: 登録簿を読めていないと違反 0 件で通ってしまう
  if ((registry.harnesses ?? []).length === 0) {
    console.error('harness-map: 登録簿にハーネスが 1 件も無い（読めていない疑い）')
    process.exit(1)
  }
  const violations = checkRegistry({ registry, root: o.root })
  if (violations.length > 0) {
    console.error('harness-map: 宣言が実物と食い違っています')
    for (const v of violations) console.error(`  - ${v}`)
    process.exit(1)
  }

  const outAbs = path.join(o.root, registry.output)
  const current = existsSync(outAbs) ? readFileSync(outAbs, 'utf8') : ''
  const next = replaceBlock(current, registry.generatedMarker, renderTables({ registry, root: o.root }))
  if (next === null) {
    console.error(`harness-map: ${registry.output} に印（generated:${registry.generatedMarker}）が見つからない`)
    process.exit(1)
  }
  if (o.check) {
    if (current === next) {
      console.log('harness-map: 最新')
      process.exit(0)
    }
    console.error('harness-map: 生成物と一致しない（bash scripts/render-harness-map.sh で作り直す）')
    process.exit(1)
  }
  writeFileSync(outAbs, next)
  console.log(`書き出した: ${registry.output}`)
}

// テストから import したときは実行しない
if (process.argv[1] && process.argv[1].endsWith('render-harness-map.mjs')) {
  main(process.argv.slice(2))
}
