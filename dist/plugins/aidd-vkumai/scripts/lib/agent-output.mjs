#!/usr/bin/env node
// `claude -p` の出力から、**中身**と**使用量**を取り出す（2026-09-10、設計提案 3「費用」）。
//
// WHY: 精度指標のうち「再現性と費用」の費用の側だけが取れていなかった。
//      2026-09-10 に実測したところ、`--output-format json` は `--json-schema` と併用でき、
//      `total_cost_usd` と `usage`（入出力トークン）を返す。中身は `structured_output`
//      （スキーマに沿って構造化済み）か `result`（文字列）に入る。
//
// WHY(包みが無い出力も受ける): eval のテストはエージェントを**モック**に差し替えており、
//      モックは素の `{"status":"pass"}` を返す。包みを前提にすると、
//      **モックが通らない＝テストが実物と違うものを測る**ことになる（C-023 と同じ形）。
//      包みがあれば剥がし、無ければそのまま通す。
//
// 限界:
//   - 費用は `total_cost_usd`（表示価格ベース）をそのまま使う。実際の請求とは一致しないことがある
//   - 包みが無い出力からは使用量を取れない（null で返す。0 とは区別する）
//
// 使い方: node scripts/lib/agent-output.mjs --payload   … 中身を標準出力へ
//         node scripts/lib/agent-output.mjs --usage     … 使用量を 1 行の JSON で
//   いずれも標準入力から `claude -p` の生出力を受ける。

/**
 * 生出力から { payload, usage } を返す。
 * payload はエージェントの答え（文字列。JSON ならその文字列表現）。
 * usage は { costUsd, inputTokens, outputTokens } か、取れなければ null。
 */
export function parseAgentOutput(raw) {
  let top
  try {
    top = JSON.parse(raw)
  } catch {
    // JSON ですらない（モデルが素のテキストを返した）。中身はそのまま、使用量は無い
    return { payload: raw, usage: null }
  }
  const isWrapped = top && typeof top === 'object' && top.type === 'result'
  if (!isWrapped) {
    // 包みが無い＝モック、または旧い形。そのまま通す
    return { payload: raw, usage: null }
  }
  const payload =
    top.structured_output !== undefined
      ? JSON.stringify(top.structured_output)
      : typeof top.result === 'string'
        ? top.result
        : JSON.stringify(top.result ?? '')
  const u = top.usage ?? {}
  return {
    payload,
    usage: {
      costUsd: typeof top.total_cost_usd === 'number' ? top.total_cost_usd : null,
      inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
      outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
      cacheReadTokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : null,
      durationMs: typeof top.duration_ms === 'number' ? top.duration_ms : null,
      isError: top.is_error === true,
    },
  }
}

function main(argv) {
  const mode = argv.includes('--usage') ? 'usage' : 'payload'
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => {
    raw += c
  })
  process.stdin.on('end', () => {
    const { payload, usage } = parseAgentOutput(raw)
    if (mode === 'usage') {
      process.stdout.write(JSON.stringify(usage ?? {}) + '\n')
    } else {
      process.stdout.write(payload)
    }
  })
}

if (process.argv[1] && process.argv[1].endsWith('agent-output.mjs')) {
  main(process.argv.slice(2))
}
