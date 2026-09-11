// scripts/lib/scan-raw-error-response.mjs
//
// WHY(2026-09-11): 入口（route）が `catch` で受けたエラーの `message` を**そのまま応答に入れる**とき、
//      それが「翻訳済みだと分かっているもの」に絞られているかを見る。
//
//      絞り方には 2 通りある。
//        (a) **ホワイトリスト**: 専用の型（マーカークラス）を作り、`instanceof` で通す
//        (b) **ブラックリスト**: 危ない語（秘密鍵・テーブル名…）を列挙して弾く
//      (b) は**列挙から漏れたものが全部そのまま出る**。DB の生エラーには制約名・列名・
//      接続情報が入るので、漏れの範囲を先に決められない。この検査は (a) を前提に、
//      **絞られていない値の使用**を数える。
//
//      きっかけ: 2026-09-11、中心リポジトリの 3 箇所が `instanceof Error` で受けて message を
//      返していた。実害は現実には起きない（PostgreSQL のエラーは英語で、分岐は日本語の文言で
//      判定していた）が、**偶然その語を含めば素通りする**構造だった。
//      同じ日に別の導入先を見ると、`service_role` だけを弾く (b) の形が見つかった。
//
// 何を見るか:
//   `catch` ブロックごとに、`error.message`（実際の変数名は問わない）を**値として**使っている箇所が
//   「安全なガード」の内側にあるか。
//     - 安全: そのブロックに `instanceof <翻訳済みの型>` がある
//     - 安全: その使用を囲む直近の `if` が `<変数>.message === <何か>`（厳密一致）
//     - 逃がし口: 行または直前の行に `raw-error-ok: <理由>`
//   値として使っている、の判定は「`.message` の直後がメソッド呼び出しでも比較でもない」こと。
//   `error.message.includes('...')` や `error.message === X` は**判定に使っているだけ**なので数えない。
//
// 限界（先に書く）:
//   - **行ベースの近似で、AST は見ない。** 入れ子の深い分岐は、直近の `if` しか見ないので取り違えうる
//   - **見るのは catch ブロックと、そこから直接呼ばれている同じファイル内の関数だけ。**
//     別ファイルへ切り出したヘルパーや、2 段以上たどる呼び出しは見えない
//     （**この範囲自体が一度穴だった**——最初の版は catch の中しか見ておらず、
//     ヘルパーへ切り出した導入先を「違反 0 件」と言った）
//   - **応答に入れたかどうかまでは追わない。** 値として使っていれば数える（ログへ出すだけでも数える）。
//     過検知の側に倒しているので、正当なものは逃がし口で理由を書いて外す
//   - **翻訳済みの型が本当に安全かは見ない。** その型の message に何を入れるかは書き手の責任
//   - **設定が無い導入先では対象 0 件で黙って通る。** 使うかどうかは導入先が決める

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeLine } from './stdout-sync.mjs'

const ROUTE_FILE = /^route\.(tsx?|jsx?|mjs)$/
const REASON = /raw-error-ok[:：][ \t]*\S/
// WHY(2026-09-11): コメント行を数えない。**この検査を入れた直後に自分で踏んだ**——
//      「`err.message` をそのまま返していた」と書いた WHY コメントが違反として出た。
//      直した理由を書けない検査は、書き手にコメントを削らせる方向に働く（C-040 の親戚）。
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/** catch (x) { ... } を、波括弧の対応を数えて 1 ブロックずつ切り出す */
export function catchBlocks(source) {
  const blocks = []
  const re = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*)?\{/g
  let m
  while ((m = re.exec(source)) !== null) {
    const varName = m[1] ?? null
    let depth = 1
    let i = re.lastIndex
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    // 開き波括弧の直後から、閉じる直前まで
    const body = source.slice(re.lastIndex, i - 1)
    const startLine = source.slice(0, m.index).split('\n').length
    blocks.push({ varName, body, startLine })
  }
  return blocks
}

/**
 * ブロック内で `<変数>.message` を**値として**使っている行を返す。
 * メソッド呼び出し（`.message.includes(`）と比較（`.message ===`）は数えない。
 */
export function valueUses(body, varName) {
  const name = varName ?? '[A-Za-z_$][\\w$]*'
  const re = new RegExp(`\\b${name}\\.message\\b(?!\\s*(?:\\.|===|!==|==|!=))`, 'g')
  const lines = body.split('\n')
  const uses = []
  lines.forEach((line, idx) => {
    if (COMMENT_LINE.test(line)) return
    re.lastIndex = 0
    if (re.test(line)) uses.push({ line, index: idx })
  })
  return uses
}

/** その使用を囲む直近の `if` が「厳密一致」で絞っているか */
function guardedByStrictEquality(lines, index, varName) {
  const name = varName ?? '[A-Za-z_$][\\w$]*'
  const strict = new RegExp(`\\b${name}\\.message\\s*(?:===|!==)`)
  // 同じ行に書いてある場合（`if (e.message === X) return apiError(e.message, 404)`）も拾う
  for (let i = index; i >= 0 && i >= index - 6; i--) {
    const line = lines[i]
    if (strict.test(line)) return true
    // 別の catch や関数の境界を跨いだら諦める
    if (/\bcatch\s*\(/.test(line) && i !== index) return false
  }
  return false
}

function hasReason(lines, index) {
  if (REASON.test(lines[index] ?? '')) return true
  return REASON.test(lines[index - 1] ?? '')
}

/**
 * その名前が、以降の行で**値として**使われているか。
 * WHY(2026-09-11): `const message = e instanceof Error ? e.message : ''` のように
 *      **いったん変数へ移して、判定にだけ使う**書き方がある（`message.includes('permission denied')`）。
 *      これを違反にすると過検知が増えて検査が読まれなくなる（C-031）。
 *      派生した変数が「返す・渡す」側で使われたときだけ数える。
 */
export function usedAsValue(lines, name, fromIndex) {
  const re = new RegExp(`\\b${name}\\b(?!\\s*(?:\\.|===|!==|==|!=|=[^=]))`)
  for (let i = fromIndex + 1; i < lines.length; i++) {
    if (re.test(lines[i])) return true
  }
  return false
}

/** その行が `const X = ... .message ...` の形なら X を返す */
function assignedName(line) {
  const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)
  return m ? m[1] : null
}

/** 開き波括弧の位置から、対応する閉じ括弧までの本体を切り出す */
function bodyFrom(source, openIndex) {
  let depth = 1
  let i = openIndex + 1
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return source.slice(openIndex + 1, i - 1)
}

/**
 * catch から呼ばれている、**同じファイル内の関数**の本体を返す。
 *
 * WHY(2026-09-11): エラーの整形を **catch の外のヘルパーへ切り出す**書き方がある
 *      （`return Response.json({ error: safeErrorMessage(error) })`）。
 *      catch ブロックだけを見ていると、そこが丸ごと見えない。
 *      **実際に踏んだ**——この走査を別の導入先へ当てたら「違反 0 件」と出たが、
 *      そこには「危ない語だけ弾いて残りは生のまま返す」ヘルパーがあった。
 *      見えていなかっただけで、守れていたわけではない。
 */
export function calledHelperBodies(source, blockBody) {
  const names = new Set()
  for (const m of blockBody.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1])
  const bodies = []
  for (const name of names) {
    const re = new RegExp(
      `(?:function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{)` +
        `|(?:\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\([^)]*\\)[^{]*\\{)`
    )
    const m = re.exec(source)
    if (!m) continue
    const open = m.index + m[0].length - 1
    bodies.push({
      name,
      body: bodyFrom(source, open),
      startLine: source.slice(0, m.index).split('\n').length,
    })
  }
  return bodies
}

/**
 * 1 ファイルを走査して違反を返す。
 * @param {string} source ファイルの中身
 * @param {string[]} translatedTypes 翻訳済みだと認める型の名前
 */
export function scanSource(source, translatedTypes) {
  const violations = []
  let examined = 0
  const seenHelpers = new Set()

  // catch から呼ばれているヘルパーの本体も同じ目で見る（1 つにつき 1 回だけ）
  const scanBody = (body, startLine, varName) => {
    const guardedByType = translatedTypes.some((t) =>
      new RegExp(`instanceof\\s+${t}\\b`).test(body)
    )
    const lines = body.split('\n')
    for (const use of valueUses(body, varName)) {
      examined++
      const derived = assignedName(use.line)
      if (derived && !usedAsValue(lines, derived, use.index)) continue
      if (guardedByType) continue
      if (guardedByStrictEquality(lines, use.index, varName)) continue
      if (hasReason(lines, use.index)) continue
      violations.push({ line: startLine + use.index, text: use.line.trim() })
    }
  }

  for (const block of catchBlocks(source)) {
    for (const helper of calledHelperBodies(source, block.body)) {
      if (seenHelpers.has(helper.name)) continue
      seenHelpers.add(helper.name)
      scanBody(helper.body, helper.startLine, null)
    }
  }

  for (const block of catchBlocks(source)) {
    const guardedByType = translatedTypes.some((t) =>
      new RegExp(`instanceof\\s+${t}\\b`).test(block.body)
    )
    const lines = block.body.split('\n')
    for (const use of valueUses(block.body, block.varName)) {
      examined++
      // いったん変数へ移した場合は、その変数が値として使われたときだけ数える
      const derived = assignedName(use.line)
      if (derived && !usedAsValue(lines, derived, use.index)) continue
      if (guardedByType) continue
      if (guardedByStrictEquality(lines, use.index, block.varName)) continue
      if (hasReason(lines, use.index)) continue
      violations.push({
        line: block.startLine + use.index,
        text: use.line.trim(),
      })
    }
  }
  return { violations, examined }
}

/** ディレクトリ配下の route ファイルを集める */
function collectRoutes(dir) {
  const found = []
  const walk = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(full)
      } else if (ROUTE_FILE.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(dir)
  return found.sort()
}

/**
 * リポジトリを走査する。
 * @param {string} repoRoot
 * @param {{translatedErrorTypes?: string[], scanDirs?: string[]}} config
 */
export function scanRepo(repoRoot, config) {
  const types = config?.translatedErrorTypes ?? []
  const dirs = config?.scanDirs ?? []
  // WHY(黙って通る): 設定を持たない導入先では、この検査は何も言わない。
  //      「対象が無い」ことと「違反が無い」ことを別々に返し、呼び出し側が見分けられるようにする。
  if (types.length === 0 || dirs.length === 0) {
    return { configured: false, files: 0, examined: 0, violations: [] }
  }
  const violations = []
  let files = 0
  let examined = 0
  for (const dir of dirs) {
    for (const file of collectRoutes(path.join(repoRoot, dir))) {
      files++
      const source = fs.readFileSync(file, 'utf8')
      const result = scanSource(source, types)
      examined += result.examined
      for (const v of result.violations) {
        violations.push({ file: path.relative(repoRoot, file), ...v })
      }
    }
  }
  return { configured: true, files, examined, violations }
}

// CLI: node scripts/lib/scan-raw-error-response.mjs [リポジトリ] [--verbose]
//   設定は <リポジトリ>/aidd.config.json の errorResponse から読む。
//   終了コード: 0 = 違反なし（設定が無い導入先も 0）/ 1 = 違反あり、または走査が空振り
if (import.meta.url === `file://${process.argv[1]}`) {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const repoRoot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : defaultRoot
  const configPath = path.join(repoRoot, 'aidd.config.json')

  let config = {}
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')).errorResponse ?? {}
    } catch (e) {
      console.error(`scan-raw-error-response: 設定を読めない（${configPath}）: ${e.message}`)
      process.exit(1)
    }
  }

  const { configured, files, examined, violations } = scanRepo(repoRoot, config)

  if (!configured) {
    writeLine('configured=false（aidd.config.json に errorResponse が無いので何も見ていない）')
    process.exit(0)
  }

  // fail-open 防止: route を 1 つも見つけられなければ、違反 0 は「探せていない」
  if (files === 0) {
    console.error('scan-raw-error-response: 対象の route を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    writeLine(`  files=${files} examined=${examined}`)
  }
  for (const v of violations) {
    writeLine(`raw-error: [${v.file}:${v.line}] ${v.text}`)
  }
  writeLine(`files=${files} examined=${examined} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
