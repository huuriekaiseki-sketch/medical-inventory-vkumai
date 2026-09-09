#!/usr/bin/env node
// ルールブック（カタログ）の形を検査する汎用エンジン。
//
// WHY: 2026-09-06〜07 の 1 週間で、同じ形のルールブックを 8 つ書いた（約束・不変条件・脅威・
//      fail-open・データの残存先・人間系の回避・アクセス経路・部分成功・到達範囲）。そのたびに
//      「列数・ID の形・重複・状態の語彙・守るテストの実在・未着手なら issue 番号」を検査する
//      bash を 150 行ずつ書き写していた。写すたびに少しずつ違う（ある検査は重複 ID を見ない、
//      別の検査はパスの実在を見ない）ので、**ルールブックが増えるほど検査の質がばらつく**。
//
//      検査の中身は全部同じなので、エンジンを 1 本にして、違うところ（列名・ID の接頭辞・
//      状態の語彙）だけを登録簿（catalog-registry.json）に書く形にする。
//      新しいルールブックを足すときに書くのは登録簿の 1 エントリと文書だけで、検査は書かない。
//
// 使い方:
//   node scripts/lib/check-catalog.mjs <registry.json> [--root <repo>] [--only <id>]
//   node scripts/lib/check-catalog.mjs --spec '<json>' --file <path> [--root <repo>]
//
// 出力: 違反を 1 行ずつ stdout に出し、最後に `violations=N`。exit code は常に 0
//       （呼び出し側の *.test.sh が件数を見て判定する）。
//
// 登録簿 1 エントリの形:
//   {
//     "id": "invariant",                       // 表示名
//     "file": "docs/agents/invariant-catalog.md",
//     "idPrefix": "I",                         // ID は I-3桁
//     "columns": 7,                            // 列数（区切り `|` の数 - 1）
//     "evidenceColumn": 6,                     // 1 始まり。守るテスト列。省略時は検査しない
//     "statusColumn": 7,                       // 1 始まり。状態列
//     "states": ["実装済み", "計画", "対象外"], // 状態の語彙（前方一致で見る）
//     "evidenceRequiredStates": ["実装済み"],   // この状態なら守るテストにパスが要る
//     "planRequiredStates": ["計画"],           // この状態なら #757-N のような計画番号が要る
//     "planPattern": "#757-[0-9]+",            // 省略時は planRequiredStates を検査しない
//     "idBands": [10, 20, 30]                  // 省略可。区分の先頭（10 刻み）。書けば帯の外を違反にする
//   }

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 表の行（`| A | B |`）を列の配列にする。前後の空文字は落とす。
 *
 * WHY(2026-09-07、`\|` を区切りにしない): あるルールブックを登録しようとしたら
 *      列数の違反が 6 件出た。中身を見ると `` `error \|\| !user` `` のように
 *      **markdown のエスケープ（`\|`）で内容としてのパイプを書いていた**行だった。
 *      これは markdown として正しく、描画すれば 1 つのセルになる。
 *      素の `split('|')` は区切りと区別できず、**正しい表を違反と報告していた**。
 *      登録済みの 7 件がたまたま `\|` を使っていなかったので表面化していなかった。
 *
 *      更新ルールの「列の中に `|` を書かない」は、**エスケープすれば書ける**へ緩められる
 *      （素のパイプは今までどおり列がずれるので書けない）。
 */
export function splitRow(line) {
  // 直前が `\` でない `|` だけを区切りにする
  const cells = line.split(/(?<!\\)\|/)
  // 先頭と末尾は `|` の外側の空文字
  return cells.slice(1, -1).map((c) => c.trim())
}

/** 仮置きのまま通さないための語 */
const PLACEHOLDER = /todo|未定|後で|あとで|（ここに|\(ここに/i

/**
 * 「この検査で見つからないこと」を先に書かせる（2026-09-07）。
 *
 * WHY: ルールブックは増える一方で、リポジトリごとに中身も変わる。だから
 *      「このルールが何を守らないか」を後から思い出すのは無理になる。
 *      先に書いておくと、**取りこぼしが起きたときに「あの限界ではないか」と最初に疑える**。
 *      実際、2026-09-07 に見つけた 3 件はどれも「その仕組みが見ていない軸」で起きており、
 *      限界が書いてあれば真っ先にそこを見に行けた。
 *
 *      2 か所に書かせる。文書の `## 限界` 節（詳しく）と、登録簿の `limits`（索引に出す 1 行）。
 *      索引に出るのが大事で、事故のときに開くのは索引 1 枚だから。
 */
export function checkLimits({ spec, text }) {
  const violations = []

  // WHY(正規表現 1 本にしない): `$` は m フラグ下で行末にも一致するため、
  //      「次の見出しまで」を 1 本の正規表現で書くと本文が空に見える（実際に踏んだ）。
  //      見出しの位置を探してから次の見出しまでを切り出す。
  const heading = text.match(/^##\s*限界[^\n]*$/m)
  if (!heading || heading.index === undefined) {
    violations.push(
      `${spec.id}: limits: 文書に「## 限界」の節が無い（この検査で見つからないことを先に書く）`,
    )
  } else {
    const after = text.slice(heading.index + heading[0].length)
    const next = after.search(/^#{1,2}\s/m)
    const body = (next >= 0 ? after.slice(0, next) : after).trim()
    if (body.length < 20) {
      violations.push(`${spec.id}: limits: 「## 限界」の中身が短すぎる（${body.length} 文字）`)
    } else if (PLACEHOLDER.test(body)) {
      violations.push(`${spec.id}: limits: 「## 限界」が仮置きのまま`)
    }
  }

  const oneLine = (spec.limits ?? '').trim()
  if (oneLine.length < 10) {
    violations.push(`${spec.id}: limits: 登録簿に limits（索引に出す 1 行）が無い`)
  } else if (PLACEHOLDER.test(oneLine)) {
    violations.push(`${spec.id}: limits: 登録簿の limits が仮置きのまま`)
  }

  return violations
}

/**
 * 1 つのルールブックを検査する。
 * @param {{spec: object, text: string, root: string}} input
 * @returns {string[]} 違反の説明（0 件なら空配列）
 */
export function checkCatalog({ spec, text, root }) {
  const violations = []
  const prefix = spec.idPrefix
  const idRe = new RegExp(`^${prefix}-[0-9]{3}$`)
  const rowRe = new RegExp(`^\\|\\s*${prefix}-`)
  const seen = new Set()
  // WHY(見出しも一緒に持つ・2026-09-09): ID の帯（10 刻み）は**節と対応している**が、
  //      その対応は今まで人が読んで守るだけだった。実際に 1 件間違えた
  //      （状態遷移の節に 06x の ID を振り、更新ルールを読み直すまで誰も落ちなかった）。
  //      行だけを集めると節が消えるので、直前の見出しを添えて持つ。
  const rows = []
  let heading = ''
  for (const l of text.split('\n')) {
    const h = /^#{2,4}\s+(.*)$/.exec(l)
    if (h) heading = h[1].trim()
    else if (rowRe.test(l)) rows.push({ line: l, heading })
  }

  if (rows.length === 0) violations.push(`${spec.id}: 行が 1 つも無い（${prefix}-xxx の行）`)

  violations.push(...checkLimits({ spec, text }))

  /** 節の見出し → その節に出てきた帯（10 刻み）の集合 */
  const bandsBySection = new Map()

  for (const { line, heading: section } of rows) {
    const cells = splitRow(line)
    const id = cells[0] ?? ''

    if (cells.length !== spec.columns) {
      violations.push(`${spec.id}: columns: [${id}] 列数が ${spec.columns} でない（${cells.length}）`)
      continue
    }
    if (!idRe.test(id)) {
      violations.push(`${spec.id}: id: [${id}] ID が ${prefix}-3桁でない`)
    }
    if (seen.has(id)) violations.push(`${spec.id}: id: [${id}] ID が重複`)
    seen.add(id)

    if (Array.isArray(spec.idBands) && spec.idBands.length > 0 && idRe.test(id)) {
      const n = Number(id.slice(prefix.length + 1))
      const band = Math.floor(n / 10) * 10
      if (!spec.idBands.includes(band)) {
        violations.push(`${spec.id}: band: [${id}] 区分の番号帯（${spec.idBands.join(' / ')}）の外`)
      }
      if (!bandsBySection.has(section)) bandsBySection.set(section, new Map())
      if (!bandsBySection.get(section).has(band)) bandsBySection.get(section).set(band, id)
    }

    const status = cells[(spec.statusColumn ?? spec.columns) - 1] ?? ''
    const known = (spec.states ?? []).find((st) => status === st || status.startsWith(st))
    if (!known) {
      violations.push(`${spec.id}: status: [${id}] 状態が語彙にない: '${status}'`)
      continue
    }

    if ((spec.planRequiredStates ?? []).includes(known) && spec.planPattern) {
      if (!new RegExp(spec.planPattern).test(status)) {
        violations.push(`${spec.id}: plan: [${id}] ${known} なのに計画番号（${spec.planPattern}）が無い`)
      }
    }

    if (spec.evidenceColumn) {
      const evidence = cells[spec.evidenceColumn - 1] ?? ''
      const paths = [...evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      if ((spec.evidenceRequiredStates ?? []).includes(known) && paths.length === 0) {
        violations.push(`${spec.id}: evidence: [${id}] ${known} なのに守るテストが無い`)
      }
      for (const p of paths) {
        // 拡張子を持つものだけをパスとして実在検査する（説明文のバッククォートを誤検知しない）
        if (!/\.(ts|tsx|mjs|js|sh|sql|md|json|yml|yaml)$/.test(p)) continue
        if (!existsSync(path.join(root, p))) {
          violations.push(`${spec.id}: path: [${id}] 守るテストのパスが存在しない: ${p}`)
        }
      }
    }
  }

  violations.push(...checkBandSections({ spec, bandsBySection }))
  return violations
}

/**
 * 節（見出し）と ID の帯が一致しているかを見る。
 *
 * WHY(2026-09-09、実際に間違えたので足した): 更新ルールには「区分ごとに 10 刻み」と書いてあるが、
 *      **書いてあるだけで誰も突き合わせていなかった**。状態遷移の節に 06x の ID を振っても
 *      15 本のルールブック検査は 1 つも落ちず、更新ルールを読み直して初めて気づいた（C-010 の型）。
 *
 * WHY(節が 1 つしか無いルールブックには掛けない): `check-design-pitfalls.md` のように
 *      **1 つの節に全部の帯を並べる**書き方も正しい（帯の意味は更新ルールの文章にある）。
 *      節で区分を表しているルールブック（行を持つ節が 2 つ以上）だけを対象にする。
 *      対象かどうかを人が宣言しないので、**書き方を変えたら勝手に対象が変わる**（宣言の陳腐化が無い）。
 *
 * 限界: 節の**名前**が区分の意味と合っているかは見ない（帯が節ごとに 1 つであることだけ）。
 *       節をまたいで同じ帯を使っていること自体は見る（下の 2 つ目）。
 */
export function checkBandSections({ spec, bandsBySection }) {
  const violations = []
  if (bandsBySection.size < 2) return violations

  for (const [section, bands] of bandsBySection) {
    if (bands.size <= 1) continue
    const detail = [...bands].map(([band, id]) => `${band}x=${id}`).join(' / ')
    violations.push(
      `${spec.id}: section: 節「${section}」に帯が ${bands.size} つ混ざっている（${detail}）。` +
        `ID の帯は節と対応させる`
    )
  }

  /** 逆向き: 同じ帯が 2 つ以上の節に散っている */
  const sectionsByBand = new Map()
  for (const [section, bands] of bandsBySection) {
    for (const band of bands.keys()) {
      if (!sectionsByBand.has(band)) sectionsByBand.set(band, [])
      sectionsByBand.get(band).push(section)
    }
  }
  for (const [band, sections] of sectionsByBand) {
    if (sections.length <= 1) continue
    violations.push(
      `${spec.id}: section: 帯 ${band}x が ${sections.length} つの節に散っている（${sections.join(' / ')}）`
    )
  }
  return violations
}

function main(argv) {
  let root = process.cwd()
  let registryPath = null
  let specJson = null
  let filePath = null
  let only = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') root = argv[++i]
    else if (a === '--spec') specJson = argv[++i]
    else if (a === '--file') filePath = argv[++i]
    else if (a === '--only') only = argv[++i]
    else registryPath = a
  }

  const specs = []
  if (specJson) {
    const spec = JSON.parse(specJson)
    specs.push({ spec, file: filePath ?? spec.file })
  } else if (registryPath) {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    for (const spec of registry.catalogs ?? []) {
      if (only && spec.id !== only) continue
      specs.push({ spec, file: spec.file })
    }
  } else {
    console.log('registry か --spec のどちらかが要る')
    console.log('violations=1')
    return
  }

  let total = 0
  for (const { spec, file } of specs) {
    const abs = path.isAbsolute(file) ? file : path.join(root, file)
    if (!existsSync(abs)) {
      console.log(`${spec.id}: ファイルが無い: ${file}`)
      total += 1
      continue
    }
    const found = checkCatalog({ spec, text: readFileSync(abs, 'utf8'), root })
    for (const v of found) console.log(v)
    total += found.length
  }
  console.log(`violations=${total}`)
}

// 直接実行されたときだけ走らせる（テストからは import して使う）
if (process.argv[1] && process.argv[1].endsWith('check-catalog.mjs')) {
  main(process.argv.slice(2))
}
