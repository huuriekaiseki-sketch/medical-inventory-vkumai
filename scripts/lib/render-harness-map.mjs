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
// WHY(「あり」をやめた、2026-09-10・レビューの設計提案 4): 状態の欄は手書きの
//      「あり / 一部 / 外部待ち」だった。登録簿自身が「『あり』は中身の十分性を保証しない」と
//      書いており、**確かめようのない 1 語**が地図でいちばん目立つ場所に載っていた。
//      同じ問いに 2 か所が別々に答える形（E-053）でもある。
//      そこで宣言と実測を分けた:
//        - **登録簿（コミットする）**: 契約の宣言だけ——守る対象の ID・前提・記録の在り処・
//          反証・測っていない理由。すべて機械で実在を確かめられる
//        - **証拠の状態（その場で計算）**: 測定 / 合格 / 最新 は実測の記録から出す
//          （`--evidence`。記録は機械ローカルなので**コミットする文書へは焼き込まない**——
//          焼き込むと環境ごとに生成物が割れ、印が実態とずれる型 C-010 を作り直すことになる）
//
// 使い方:
//   node scripts/lib/render-harness-map.mjs <registry.json> --root <repo> [--check]
//   node scripts/lib/render-harness-map.mjs <registry.json> --root <repo> --evidence
//
// --check:    書き込まず、いまの文書が生成物と一致するかだけ見る（一致すれば exit 0、違えば 1）
// --evidence: 実測の記録を読み、役割ごとの 測定 / 合格 / 最新 と未検証の理由を出す

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

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
 * ルールブックに実在する ID の索引を作る（`I-010` などが本当に台帳の行かを見るため）。
 *
 * 台帳はどれも `| <ID> | ...` の表なので、行頭のセルだけを見る。
 * 登録簿（catalog-registry.json）が無い導入先では空を返す——**その場合 guardIds の
 * 実在は確かめられない**ので、呼び出し側は「確かめられなかった」と分かる形にする。
 */
export function catalogIdIndex(root, readFile = (p) => readFileSync(p, 'utf8')) {
  const registryPath = path.join(root, 'scripts/lib/catalog-registry.json')
  let catalogs
  try {
    catalogs = JSON.parse(readFile(registryPath)).catalogs ?? []
  } catch {
    return null
  }
  const ids = new Set()
  for (const c of catalogs) {
    let text
    try {
      text = readFile(path.join(root, c.file))
    } catch {
      continue
    }
    for (const m of text.matchAll(/^\|\s*([A-Z]{1,2}-\d{3})\s*\|/gm)) ids.add(m[1])
  }
  return ids
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
  catalogIds = catalogIdIndex(root),
}) {
  const violations = []
  const triggers = Object.keys(registry.triggers ?? {})
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

    // ── 契約（レビューの設計提案 1）──────────────────────────────
    // 対象: 守ると言っている不変条件・脅威・操作の ID が**台帳に実在する**か。
    //       文章だけの「何を守るか」は機械で追えないので、追える形の宣言を求める。
    //       宣言できない役割（手順そのものを守る等）は理由を書かせる。
    const guardIds = h.guardIds ?? []
    if (guardIds.length === 0) {
      if (!h.guardIdsReason) {
        violations.push(`missing-guard-ids: ${at}（守る対象の ID が無い。書けないなら guardIdsReason に理由を書く）`)
      }
    } else if (catalogIds) {
      for (const gid of guardIds) {
        if (!catalogIds.has(gid)) violations.push(`unknown-guard-id: ${at} → ${gid} はどの台帳にも無い`)
      }
    }
    // 前提: データ・認証・依存・初期状態。要らないなら「なし」と書かせる（空欄にさせない）
    if (!h.preconditions) {
      violations.push(`missing-preconditions: ${at}（前提が空。要らないなら「なし」と書く）`)
    }
    // 観測: 実測の記録の在り処。持たないなら**なぜ持たないか**を書かせる
    const evidence = h.evidence ?? []
    if (evidence.length === 0) {
      if (!h.unmeasuredReason) {
        violations.push(`missing-evidence: ${at}（実測の記録が無い。無いなら unmeasuredReason に理由を書く）`)
      }
    }
    for (const e of evidence) {
      if (!e.log) violations.push(`evidence-without-log: ${at} → ${e.name ?? '(名前なし)'}`)
      // WHY(コミットで見張る道、2026-09-10): 木のハッシュで表せない結果がある。
      //      マージ予行（H-08）は「いま main に何が入っているか」に依存し、
      //      どれか 1 つのディレクトリの木では表せない。
      //      無理に木へ載せると「変わっていないのに最新」と言ってしまう（C-010）。
      //      **どちらか一方は必ず要る**——両方無ければ最新かを永久に判定できない。
      if ((e.watch ?? []).length === 0 && e.watchCommit !== true) {
        violations.push(
          `evidence-without-watch: ${at} → ${e.name ?? '(名前なし)'}（どの木に対する結果かが分からない。` +
            '木で表せないなら watchCommit: true）'
        )
      }
      for (const w of e.watch ?? []) {
        if (!exists(path.join(root, w))) violations.push(`missing-watch-path: ${at} → ${w}`)
      }
    }
    // 反証: 正常を通し、既知の壊し方を止めることを確かめている場所
    if (!h.falsification) {
      violations.push(`missing-falsification: ${at}（壊して落ちることを確かめている場所の宣言が無い）`)
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

/**
 * 記録の置き場。worktree をまたいで共有される（scripts/lib/resolve-log-dir.sh と同じ考え方）。
 * git が無ければ root 直下の logs/ へ落ちる。
 */
export function resolveLogDir(root, run = execFileSync) {
  try {
    const common = String(
      run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }),
    ).trim()
    if (common) return path.join(path.dirname(common), 'logs')
  } catch {
    /* git が無い環境では下へ落ちる */
  }
  return path.join(root, 'logs')
}

/** 記録の**最後に読める 1 行**を返す。1 行も読めなければ null */
export function lastRecord(file, readFile = (p) => readFileSync(p, 'utf8')) {
  let text
  try {
    text = readFile(file)
  } catch {
    return null
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {
      /* 壊れた行は飛ばして、その前を見る */
    }
  }
  return null
}

/** いまの HEAD における `path` の木のハッシュ。取れなければ null */
function headTree(root, target, run = execFileSync) {
  try {
    return String(run('git', ['rev-parse', `HEAD:${target}`], { cwd: root })).trim()
  } catch {
    return null
  }
}

/**
 * 役割ごとの**証拠の状態**を実測の記録から出す（レビューの設計提案 4）。
 *
 * 3 つを別々に返す。潰さないのが肝（C-025）:
 *   - 測定: 記録が 1 行でもあるか（＝一度でも実際に回したか）
 *   - 合格: 直近の記録が pass か
 *   - 最新: 直近の記録が**いまの木**に対して取られたか
 *
 * 限界: 見るのは HEAD の木のハッシュだけで、**未コミットの書き換えは見ない**。
 *       そちらは Stop hook（check-full-run-before-finish.sh）の担当で、
 *       ここで見ると同じことを 2 か所が別々に答えることになる。
 */
/** いまの HEAD の短いコミット ID。取れなければ null（「判定できない」に倒すため） */
export function headCommit(root, run = execFileSync) {
  try {
    const out = String(run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })).trim()
    return out || null
  } catch {
    return null
  }
}

export function evidenceState({ root, harness, logDir, read = lastRecord, tree = headTree }) {
  const rows = []
  for (const e of harness.evidence ?? []) {
    const file = path.join(logDir, path.posix.basename(e.log))
    const record = read(file)
    if (!record) {
      rows.push({ name: e.name, measured: false, passed: null, fresh: null, reason: '記録が 1 行も無い（一度も回していない）' })
      continue
    }
    const passField = e.pass?.field ?? 'result'
    const passValue = e.pass?.value ?? 'pass'
    const passed = record[passField] === passValue
    const stale = []
    let unknownTree = false
    for (const w of e.watch ?? []) {
      const recorded = record[`${path.posix.basename(w)}Tree`]
      if (recorded === undefined) {
        unknownTree = true
        continue
      }
      if (recorded !== tree(root, w)) stale.push(w)
    }
    // コミットで見張る（木で表せない結果のため）。記録の commit と いまの HEAD を比べる
    if (e.watchCommit === true) {
      const recorded = record.commit
      const now = headCommit(root)
      if (recorded === undefined || now === null) unknownTree = true
      else if (recorded !== now) stale.push('HEAD のコミット')
    }
    const fresh = unknownTree ? null : stale.length === 0
    let reason = ''
    if (!passed) reason = `直近が ${JSON.stringify(record[passField])}（赤のまま）`
    else if (fresh === null) reason = '記録に木のハッシュ（またはコミット）が無く、最新かどうか判定できない'
    else if (!fresh) reason = `${stale.join('・')} が記録時から変わっている`
    rows.push({ name: e.name, measured: true, passed, fresh, reason, at: record.at ?? record.timestamp })
  }
  return rows
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
  lines.push('| 役割 | 何を守るか | 起動 | 入口 | 検査 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const h of registry.harnesses ?? []) {
    const entry = (h.entrypoints ?? []).map((e) => `\`${e}\``).join('<br>')
    lines.push(
      `| ${cell(h.role)}（${h.id}） | ${cell(h.guards)} | **${cell(h.trigger)}**（${cell(h.triggerDetail)}） | ${entry} | ${(h.checks ?? []).length} 本 |`,
    )
  }
  lines.push('')
  // 契約（レビューの設計提案 1）。**どれも実在を機械で確かめられる宣言だけ**を載せる。
  // 「あり / 一部」のような確かめようのない 1 語はここには無い——
  // いま測れているかは `bash scripts/show-harness-evidence.sh` が実測の記録から出す。
  lines.push('**契約（守る対象・前提・実測の記録・反証）**')
  lines.push('')
  lines.push('| 役割 | 守る対象 | 前提 | 実測の記録 | 反証（壊して落ちることの確認） |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const h of registry.harnesses ?? []) {
    const ids = (h.guardIds ?? []).length > 0
      ? (h.guardIds ?? []).map((g) => `\`${g}\``).join(' ')
      : `—（${cell(h.guardIdsReason)}）`
    const ev = (h.evidence ?? []).length > 0
      ? (h.evidence ?? []).map((e) => `${cell(e.name)}<br>\`${e.log}\``).join('<br><br>')
      : `—（${cell(h.unmeasuredReason)}）`
    lines.push(`| ${cell(h.role)}（${h.id}） | ${ids} | ${cell(h.preconditions)} | ${ev} | ${cell(h.falsification)} |`)
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
  // WHY(「全数」と書かないこと。2026-09-11): この行は地図でいちばん読まれる場所にある。
  //     ここで「全数」と書くと、**vitest 側の検査も網羅していると読める**が、実際に
  //     「どこにも属さない検査があれば落ちる」が効くのは `scripts/**/*.test.sh` だけで、
  //     vitest は 296 本のうち役割を持たせたものを手で足す運用（限界の節に書いてある）。
  //     いちばん目立つ場所に、確かめていないことを書かない（C-010）。
  const shellTotal = (registry.harnesses ?? []).reduce(
    (n, h) => n + (h.checks ?? []).filter((c) => c.endsWith('.test.sh')).length,
    0,
  )
  lines.push(
    `（ハーネス ${(registry.harnesses ?? []).length} 件・検査 ${checkTotal} 本・台帳 ${ledgers.length} 件。` +
      `うち \`scripts/**/*.test.sh\` の ${shellTotal} 本は**この表で全数**——` +
      `どこにも属さない検査があれば生成そのものが落ちる。` +
      `残り ${checkTotal - shellTotal} 本は vitest 側から**手で足したもの**で、書き忘れは検知されない（限界の節））`,
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

/** `--evidence` の出力（人が読む用）。1 行 = 1 つの実測の記録 */
export function renderEvidence({ registry, root, logDir }) {
  const lines = []
  const mark = (b) => (b === null ? '？' : b ? '✅' : '❌')
  let measurable = 0
  let green = 0
  for (const h of registry.harnesses ?? []) {
    const rows = evidenceState({ root, harness: h, logDir })
    if (rows.length === 0) {
      lines.push(`${h.id} ${h.role}: ➖ 実測の記録を持たない（${h.unmeasuredReason}）`)
      continue
    }
    for (const r of rows) {
      measurable++
      if (r.measured && r.passed && r.fresh) green++
      const when = r.at ? `（${r.at}）` : ''
      lines.push(
        `${h.id} ${h.role}: ${r.name} — 測定 ${mark(r.measured)} / 合格 ${mark(r.passed)} / 最新 ${mark(r.fresh)}${when}` +
          (r.reason ? `\n    ${r.reason}` : ''),
      )
    }
  }
  lines.push('')
  lines.push(`実測の記録を持つもの ${measurable} 件のうち、いまの木で緑なのは ${green} 件`)
  lines.push('限界: 見るのは HEAD の木のハッシュだけで、未コミットの書き換えは見ない（それは Stop hook の担当）')
  return lines.join('\n')
}

function main(argv) {
  const o = { root: process.cwd(), check: false, evidence: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.root = argv[++i]
    else if (argv[i] === '--check') o.check = true
    else if (argv[i] === '--evidence') o.evidence = true
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

  // 証拠の状態は**その場で計算する**（コミットする文書へは焼き込まない。冒頭の WHY 参照）
  if (o.evidence) {
    writeLine(renderEvidence({ registry, root: o.root, logDir: resolveLogDir(o.root) }))
    process.exit(0)
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
      writeLine('harness-map: 最新')
      process.exit(0)
    }
    console.error('harness-map: 生成物と一致しない（bash scripts/render-harness-map.sh で作り直す）')
    process.exit(1)
  }
  writeFileSync(outAbs, next)
  writeLine(`書き出した: ${registry.output}`)
}

// テストから import したときは実行しない
if (process.argv[1] && process.argv[1].endsWith('render-harness-map.mjs')) {
  main(process.argv.slice(2))
}
