#!/usr/bin/env node
// 「標準出力へ書いたあとに `process.exit()` を呼ぶ」書き方を探す（C-051 の ratchet）。
//
// WHY(2026-09-11): C-051 の門（check-stdout-truncation.test.sh）は、機序がいま起きることと
//      名指しした 4 本の CLI がパイプで切れないことを測るだけで、**新しく書かれた 1 本**は
//      誰も見ていなかった。E-080 で 32 ファイル 120 箇所を直したのに、
//      **増えないようにする仕掛けが無い**——直した日がいちばん綺麗で、あとは劣化するだけ。
//
//      実測すると、そのとき直し切れていない箇所も残っていた（`e2e/` は走査の外だった）。
//      「限界」に書いてあったのは 2 本だが、実際は 4 本。**限界の記述のほうが間違っていた**。
//
// 判定（順序を見る。ファイル単位で「両方ある」を見るのでは足りない）:
//      エラー経路の `process.exit(1)` が**出力より前に**書いてあるだけのファイルは安全で、
//      実際 `reconstruct-loop-observability.ts` がそれだった。だから
//      **最初の生の書き出しより後ろに `process.exit(` があるか**だけを見る。
//
// 限界:
//   - 行の順番で見るので、**到達しない exit** も違反として数える（過検知側へ倒す）。
//     逆に、関数を跨いで後ろから呼ばれる exit は前に書いてあれば見逃す（過小検知）。
//   - `console.error` は見ない（stderr は Node では常に同期）。
//   - 免除の一覧は導入先のもの（`aidd.config.json` の `stdoutSync.exemptions`）。
//     **エンジンは配る・一覧は導入先が持つ**。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  'worktrees',
  'coverage',
  'eval-fixtures',
])
const TARGET = /\.(mjs|js|ts|tsx)$/
/** 行まるごとがコメントなら、その行は無いものとして読む（WHY に例を書けるようにする。C-040 の裏返し） */
const COMMENT_LINE = /^\s*(\/\/|\*|#|\/\*)/
/** 生の書き出し。`writeLine` は直した形なので数えない */
const RAW_WRITE = /console\.log\(|process\.stdout\.write\(/
const HARD_EXIT = /process\.exit\(/

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const p = path.join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (TARGET.test(name)) out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * @param {string} root 走査するルート
 * @param {Record<string,string>} exemptions 免除（相対パス → 理由）
 */
export function scanStdoutExit(root, exemptions = {}) {
  const files = listFiles(root)
  const violations = []
  const hitExemptions = new Set()

  for (const abs of files) {
    const rel = path.relative(root, abs)
    let lines
    try {
      lines = readFileSync(abs, 'utf8').split('\n')
    } catch {
      continue
    }
    let firstWrite = -1
    for (let i = 0; i < lines.length; i++) {
      if (COMMENT_LINE.test(lines[i])) continue
      if (RAW_WRITE.test(lines[i])) {
        firstWrite = i
        break
      }
    }
    if (firstWrite < 0) continue

    let exitLine = -1
    for (let i = firstWrite + 1; i < lines.length; i++) {
      if (COMMENT_LINE.test(lines[i])) continue
      if (HARD_EXIT.test(lines[i])) {
        exitLine = i
        break
      }
    }
    if (exitLine < 0) continue

    if (Object.prototype.hasOwnProperty.call(exemptions, rel)) {
      hitExemptions.add(rel)
      continue
    }
    violations.push({ file: rel, writeLine: firstWrite + 1, exitLine: exitLine + 1 })
  }

  const declared = Object.keys(exemptions).filter((k) => !k.startsWith('_'))
  return {
    scanned: files.length,
    violations,
    // 一度も当たらない免除は腐っている（C-049）
    unusedExemptions: declared.filter((k) => !hitExemptions.has(k)),
    // 理由の無い免除は「なぜ今も要るか」を誰も言えない
    emptyReasons: declared.filter((k) => String(exemptions[k] ?? '').trim() === ''),
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan-stdout-exit.mjs')) {
  const root = process.argv[2] ?? '.'
  let exemptions = {}
  if (process.argv[3]) {
    try {
      exemptions = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    } catch (e) {
      console.error(`免除の一覧を読めない: ${process.argv[3]}（${e.message}）`)
      process.exitCode = 1
    }
  }
  const r = scanStdoutExit(root, exemptions)
  writeLine(`scanned=${r.scanned}`)
  for (const v of r.violations) {
    writeLine(`NG ${v.file}:${v.writeLine} で標準出力へ書いたあと ${v.exitLine} 行で process.exit() を呼ぶ`)
  }
  for (const k of r.unusedExemptions) writeLine(`NG 免除 ${k} は一度も当たっていない（消すこと）`)
  for (const k of r.emptyReasons) writeLine(`NG 免除 ${k} の理由が空`)
  writeLine(
    `violations=${r.violations.length} unusedExemptions=${r.unusedExemptions.length} emptyReasons=${r.emptyReasons.length}`,
  )
}
