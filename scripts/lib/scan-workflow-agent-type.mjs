#!/usr/bin/env node
// ワークフローの agent() 呼び出しが agentType を持っているかを走査する（issue #791）。
//
// WHY(2026-09-18): `agent()` に agentType を渡さないと「既定のワークフロー用サブエージェント」＝
//      **全ツール持ち**として起動する。`.claude/agents/*.md` の `tools:` は適用されず、
//      PreToolUse の読み取り専用ガード（check-readonly-bash.sh）も **agent_type が空なので exit 0** で
//      素通りする。つまり**ガードを 2 つ書いてあるのに、どちらも一度も発火しない**。
//
//      実際に 2026-09-18、停止①より前の Judge Panel の採点役が製品コード 4 ファイルを編集し
//      `git commit` まで実行した（E-094 / issue #791）。採点役に書き込み手段があること自体が誤りだった。
//
//      **agentType を付けるだけでは足りない。** その型が readonlyAgentTypes に載っていなければ
//      ガードは「対象ロールではない」と判断して何もしない。両方が揃って初めて効くので、両方を見る。
//
// 使い方:
//   node scripts/lib/scan-workflow-agent-type.mjs --file <workflow.js> --agents <dir> --config <aidd.config.json>
// 出力: 1 行 1 違反（NG ...）と、末尾に calls=/missing=/unknown=/notReadonly=
// 終了コード: 0 = 違反なし / 1 = 違反あり / 2 = 走査できない
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'

/**
 * コメントと文字列リテラルを、**長さと改行を保ったまま**空白に潰す。
 *
 * WHY(C-011 の 4 度目・2026-09-18): 最初に書いた走査器はここを除外しておらず、
 *      `// issue #521: agent()失敗(null)による…` のようなコメントと、
 *      `log(\`…agent()失敗が…\`)` のようなテンプレートリテラルを**呼び出しとして数えた**
 *      （18 件中 5 件が誤検出。本物の見落としは 0）。位置を保つので行番号はずれない。
 *
 * 限界: 正規表現リテラルは潰さない。その中に引用符があると、そこから先の判定が崩れる。
 */
export function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        if (src[i] === quote) {
          out += ' '
          i++
          break
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * agent( の呼び出しを、対応する閉じ括弧まで括弧の数で切り出す。
 *
 * WHY(包んだ呼び出しも拾う、issue #797): `agent(` を単語境界つきで探すので、
 *      期待件数を数えるために `trackedAgent(...)` と包むと、**この走査から丸ごと消える**。
 *      そうなると issue #791 で入れた agentType の検査が deep-task を一切見なくなり、
 *      「違反 0 件」が「見ていない」に化ける（C-044）。包んだ形も呼び出しとして数える。
 */
const CALL_NAMES = ['agent(', 'trackedAgent(']

export function extractAgentCalls(rawSrc) {
  // WHY: opts の中身（label / agentType）は文字列なので、**潰す前の原文**から読む必要がある。
  //      位置合わせのため、潰した側で「どこが呼び出しか」を決め、切り出しは原文から行う。
  const src = stripCommentsAndStrings(rawSrc)
  const calls = []
  for (let i = 0; i < src.length; i++) {
    const name = CALL_NAMES.find((n) => src.startsWith(n, i))
    if (!name) continue
    // 単語境界。parallel( や myAgent( を拾わない
    if (i > 0 && /[A-Za-z0-9_$.]/.test(src[i - 1])) continue
    // WHY(定義は呼び出しではない): `function trackedAgent(prompt, opts)` の定義行を
    //      呼び出しとして数えると、opts がリテラルでないので「agentType が無い」と出る（自家中毒）
    if (/function\s+$/.test(src.slice(Math.max(0, i - 12), i))) continue
    let depth = 0
    let j = i + name.length - 1 // 開き括弧そのものから数え始める
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) continue // 閉じていない（走査できない形）
    const text = rawSrc.slice(i, j + 1) // opts の文字列を読むので原文から切る
    calls.push({
      line: src.slice(0, i).split('\n').length,
      callee: name.slice(0, -1), // 'agent' か 'trackedAgent'
      label: (text.match(/label:\s*[`'"]([^`'"]*)/) ?? [])[1] ?? '(label なし)',
      agentType: (text.match(/agentType:\s*['"]([^'"]+)['"]/) ?? [])[1] ?? null,
    })
    i = j
  }
  return calls
}

const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const file = flag('--file')
const agentsDir = flag('--agents')
const configPath = flag('--config')

try {
  if (!file || !existsSync(file)) {
    // WHY(C-025): 対象が無いのを「違反なし」と言わない。走査できないことは別の答え
    console.error(`scan-workflow-agent-type: 対象を読めない（${file ?? '--file 未指定'}）`)
    process.exit(2)
  }
  const calls = extractAgentCalls(readFileSync(file, 'utf8'))

  const known = new Set()
  if (agentsDir && existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((x) => x.endsWith('.md'))) {
      known.add(path.basename(f, '.md'))
    }
  }
  let readonly = null
  if (configPath && existsSync(configPath)) {
    try {
      readonly = new Set(JSON.parse(readFileSync(configPath, 'utf8')).readonlyAgentTypes ?? [])
    } catch {
      readonly = null
    }
  }

  // WHY(--require-wrapper、issue #797): 期待件数は `trackedAgent()` が数える。
  //      素の `agent()` で呼ぶと**その 1 体だけ数から漏れ**、gap check が黙って過小評価になる
  //      （漏れているのに「期待どおり」と出るので、記録漏れ検知そのものが嘘をつく）。
  const requireWrapper = process.argv.includes('--require-wrapper')

  let missing = 0
  let unknown = 0
  let notReadonly = 0
  let unwrapped = 0
  for (const c of calls) {
    if (requireWrapper && c.callee === 'agent') {
      unwrapped++
      writeLine(
        `NG ${path.basename(file)}:${c.line} [${c.label}] 素の agent() で呼んでいる（trackedAgent() で包まないと期待件数から漏れる）`,
      )
    }
    if (!c.agentType) {
      missing++
      writeLine(`NG ${path.basename(file)}:${c.line} [${c.label}] agentType が無い（全ツール持ちで起動する）`)
      continue
    }
    if (known.size > 0 && !known.has(c.agentType)) {
      unknown++
      writeLine(`NG ${path.basename(file)}:${c.line} [${c.label}] agentType "${c.agentType}" に対応する定義が無い`)
    }
    if (readonly && !readonly.has(c.agentType)) {
      notReadonly++
      writeLine(
        `NG ${path.basename(file)}:${c.line} [${c.label}] agentType "${c.agentType}" が readonlyAgentTypes に無い（ガードが対象ロールと見なさない）`,
      )
    }
  }

  // WHY(C-044): 1 件も拾えないのは「違反なし」ではなく走査の故障。緑にしない
  if (calls.length === 0) {
    console.error('scan-workflow-agent-type: agent() の呼び出しを 1 件も見つけられない（走査が壊れている疑い）')
    process.exit(2)
  }

  writeLine(
    `calls=${calls.length} missing=${missing} unknown=${unknown} notReadonly=${notReadonly} unwrapped=${unwrapped}`,
  )
  process.exit(missing + unknown + notReadonly + unwrapped > 0 ? 1 : 0)
} catch (e) {
  console.error(`scan-workflow-agent-type: 走査できない（${e.message}）`)
  process.exit(2)
}
