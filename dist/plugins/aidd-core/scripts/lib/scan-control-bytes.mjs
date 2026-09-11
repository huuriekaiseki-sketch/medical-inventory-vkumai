#!/usr/bin/env node
// 制御バイト（TAB・LF・CR 以外の C0 制御文字と DEL）を探す。追跡中のテキストとコミットメッセージの ratchet。
//
// WHY(2026-09-11): 2 本の .mjs の文字列に、区切りのつもりの NUL が**生のバイト**で入っていた。
//      git がファイルを binary と判定するので diff / blame / 3-way merge が効かず、
//      grep 系の走査からも「Binary file」として外れる。**検査 142 本のどれにも掛からなかった**
//      （外部レビューで見つかった。docs/agents/escaped-defects.md の E-082）。
//
//      原因は書き出しの経路にあった。エスケープのつもりで書いた「バックスラッシュ + u0000」が、
//      ファイルに書かれる時点で実際の NUL になっていた。同じ日にコミットメッセージの下書きでも
//      同じことが起きた（docs/agents/check-design-pitfalls.md の C-052）。
//      **書いた内容は正しく見えるのに、道具の癖で結果が変わる**——C-050 / C-051 と同じ帯。
//
//      git 自身は NUL だけはコミットメッセージで拒むが、ESC / BS / DEL などは**通して記録する**
//      （2026-09-11、git 2.50.1 で実測）。だからメッセージも見る。
//
// 判定: 0x00〜0x1f のうち TAB（0x09）・LF（0x0a）・CR（0x0d）以外と、DEL（0x7f）。
//      **バイトの数値で比べる**。正規表現にエスケープで書くと、書き出しの道具によっては
//      それ自体が化ける（今日の事故そのもの）。数値の比較なら化けようがない。
//
// 使い方:
//   node scripts/lib/scan-control-bytes.mjs --files   --root <dir> [--allow <json>]
//   node scripts/lib/scan-control-bytes.mjs --commits --root <dir> [--allow <json>] [--rev HEAD]
//   node scripts/lib/scan-control-bytes.mjs --message <file>          # git の commit-msg hook から
// 免除（--allow）は { "<パス または コミットの先頭 7 桁以上>": "<理由>" }。
// 終了コード: 0 = 無い / 1 = ある（または免除が腐っている） / 2 = 走査できない（git が使えない・読めない）
//
// 限界:
//   - binary は拡張子で外す（BINARY_EXT）。拡張子の無い binary やここに無い形式は誤検知しうる。
//     そのときは拡張子を足すか、免除（aidd.config.json の controlBytes.allowedFiles）に理由つきで足す
//   - コミットは **HEAD から辿れるもの**だけを見る。ほかのブランチは、そのブランチで回したときに見る
//   - C1 制御文字（U+0080〜U+009F）と、見えない Unicode（ゼロ幅文字など）は見ない（実例が無い）
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

export const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.mp4', '.mov', '.webm',
])

/** 見逃さない制御バイトか（TAB・LF・CR は通す） */
export function isControlByte(b) {
  if (b === 0x7f) return true
  if (b >= 0x20) return false
  return b !== 0x09 && b !== 0x0a && b !== 0x0d
}

/** buf の中の制御バイトを {line, offset, byte} で返す（多すぎると読めないので max 件まで） */
export function findControlBytes(buf, max = 10) {
  const out = []
  let line = 1
  let lineStart = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x0a) {
      line++
      lineStart = i + 1
      continue
    }
    if (isControlByte(b)) {
      out.push({ line, offset: i - lineStart + 1, byte: b })
      if (out.length >= max) break
    }
  }
  return out
}

const hex = (b) => `0x${b.toString(16).padStart(2, '0')}`
export const describe = (hits) => hits.map((h) => `${h.line} 行 ${h.offset} バイト目 ${hex(h.byte)}`).join(' / ')

/** 人に見せる文字列から制御文字を ? に替える（出力そのものに制御バイトを混ぜない） */
const printable = (s) => [...s].map((c) => (isControlByte(c.charCodeAt(0)) ? '?' : c)).join('')

function readAllow(file) {
  if (!file) return {}
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 免除の衛生（C-049）。当たらなかった宣言と、理由の無い宣言を返す */
function allowanceProblems(allow, hitKeys) {
  const keys = Object.keys(allow).filter((k) => !k.startsWith('_'))
  return {
    unused: keys.filter((k) => !hitKeys.has(k)),
    emptyReasons: keys.filter((k) => String(allow[k] ?? '').trim() === ''),
  }
}

/** 追跡中のテキストファイルを走査する */
export function scanTrackedFiles(root, allow = {}) {
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  // 区切りは NUL。**エスケープで書かず数値から作る**（上の WHY を参照）
  const files = listed.toString('utf8').split(String.fromCharCode(0)).filter(Boolean)
  const violations = []
  const hitKeys = new Set()
  let scanned = 0
  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue
    let buf
    try {
      buf = readFileSync(path.join(root, rel))
    } catch {
      continue // 索引にはあるが作業ツリーに無い・ディレクトリ（submodule）など
    }
    scanned++
    const hits = findControlBytes(buf)
    if (hits.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(allow, rel)) {
      hitKeys.add(rel)
      continue
    }
    violations.push({ where: rel, hits })
  }
  return { scanned, violations, ...allowanceProblems(allow, hitKeys) }
}

const END = '<<<END-OF-COMMIT-MESSAGE>>>'

/** rev（既定 HEAD）から辿れるコミットメッセージを走査する */
export function scanCommitMessages(root, allow = {}, rev = 'HEAD') {
  const out = execFileSync('git', ['-C', root, 'log', `--format=%H%n%B%n${END}`, rev], {
    maxBuffer: 256 * 1024 * 1024,
  })
  // latin1 で読むと 1 文字 = 1 バイトになり、バイトの位置をそのまま数えられる
  const text = out.toString('latin1')
  const violations = []
  const hitKeys = new Set()
  let scanned = 0
  for (const chunk of text.split(`${END}\n`)) {
    if (!chunk.trim()) continue
    const nl = chunk.indexOf('\n')
    const sha = chunk.slice(0, nl)
    const body = Buffer.from(chunk.slice(nl + 1), 'latin1')
    scanned++
    const hits = findControlBytes(body)
    if (hits.length === 0) continue
    const key = Object.keys(allow).find((k) => !k.startsWith('_') && k.length >= 7 && sha.startsWith(k))
    if (key) {
      hitKeys.add(key)
      continue
    }
    const subject = printable(body.toString('utf8').split('\n')[0]).slice(0, 60)
    violations.push({ where: `${sha.slice(0, 10)}（${subject}）`, hits })
  }
  return { scanned, violations, ...allowanceProblems(allow, hitKeys) }
}

function flag(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && process.argv[1].endsWith('scan-control-bytes.mjs')) {
  const args = process.argv.slice(2)
  try {
    if (args.includes('--message')) {
      const hits = findControlBytes(readFileSync(flag('--message')))
      if (hits.length === 0) process.exit(0)
      writeLine(`NG コミットメッセージに制御バイト: ${describe(hits)}`)
      process.exit(1)
    }
    const root = flag('--root') ?? process.cwd()
    const allow = readAllow(flag('--allow'))
    const r = args.includes('--commits')
      ? scanCommitMessages(root, allow, flag('--rev') ?? 'HEAD')
      : scanTrackedFiles(root, allow)
    writeLine(`scanned=${r.scanned}`)
    for (const v of r.violations) writeLine(`NG ${v.where}: ${describe(v.hits)}`)
    for (const k of r.unused) writeLine(`NG 免除 ${k} は一度も当たっていない（消すこと）`)
    for (const k of r.emptyReasons) writeLine(`NG 免除 ${k} の理由が空`)
    writeLine(
      `violations=${r.violations.length} unusedAllowances=${r.unused.length} emptyReasons=${r.emptyReasons.length}`,
    )
    process.exit(r.violations.length + r.unused.length + r.emptyReasons.length > 0 ? 1 : 0)
  } catch (e) {
    // WHY(C-025): 「走査できなかった」を「無かった」と読ませない。1 とも 0 とも違う 2 で返す
    console.error(`scan-control-bytes: 走査できない（${e.message}）`)
    process.exit(2)
  }
}
