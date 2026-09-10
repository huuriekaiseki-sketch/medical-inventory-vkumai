#!/usr/bin/env node
// 精度指標を役割別に出す（2026-09-10、レビューの設計提案 3）。
//
// WHY: 精度を 1 つの数字にまとめると、性質の違う問いが混ざって意味を失う。
//      見逃し率（見つけられたか）と指摘の正確さ（出した指摘が正しいか）は別の問いで、
//      そこへ**測れなかった件数**を混ぜると、どちらも読めなくなる。
//
//      特に効くのが 2 つ:
//        1. **実行不能を分母から黙って消さない。** 「18/18 倒した」は、測れなかった 3 件を
//           分母からも消していれば嘘になる（2026-09-10 まで RLS の変異計測が実際にそうだった）
//        2. **同条件のばらつきを見る。** 1 回の実行を合否に使うと、モデルの揺れを
//           仕組みの劣化と読み違える。同じ fixture が 2/2 と 1/2 を行き来するのを
//           2026-09-10 に実測した（それまで手作業で記録を掘るしか無かった）
//
// 使い方: node scripts/lib/precision-metrics.mjs <registry.json> --root <repo> [--runs N]
//   --runs N: ばらつきを見る直近の実行回数（既定 5。レビューの「3〜5 回」に合わせる）

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** 記録を新しい順に最大 limit 行読む。壊れた行は飛ばす */
export function readRecords(file, limit = Infinity, readFile = (p) => readFileSync(p, 'utf8')) {
  let text
  try {
    text = readFile(file)
  } catch {
    return []
  }
  const out = []
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch {
      /* 壊れた行は飛ばす */
    }
  }
  return out
}

/**
 * 同じ条件で複数回回したときのばらつき。
 *
 * 返すのは { runs, min, max, spread, flaky }。**flaky は「同じ条件なのに結果が違う」**という
 * 意味であって、良し悪しではない。1 回の実行を合否に使ってよいかの判断材料。
 */
export function spread(values) {
  if (values.length === 0) return { runs: 0, min: null, max: null, spread: null, flaky: false }
  const min = Math.min(...values)
  const max = Math.max(...values)
  return { runs: values.length, min, max, spread: max - min, flaky: values.length > 1 && min !== max }
}

/**
 * 「同じ条件」の回だけを残す（2026-09-10、設計提案 3「再現性」）。
 *
 * WHY: 条件を確かめずにばらつきを出すと、**モデルの揺れ**と**その間にコードが変わっただけ**を
 *      区別できない。区別できない数字は判断に使えない。
 *      `conditionFields` に挙げた欄が**いちばん新しい回と同じ**回だけを比べる。
 *
 * 欄を 1 つも持たない古い記録は「条件が分からない」ので比較から外す
 * （黙って混ぜない。外した件数は呼び出し側が出す）。
 */
export function sameCondition(records, conditionFields) {
  if (!conditionFields || conditionFields.length === 0) return { kept: records, dropped: 0 }
  const latest = records[0]
  if (!latest) return { kept: [], dropped: 0 }
  const known = conditionFields.filter((f) => latest[f] !== undefined)
  if (known.length === 0) return { kept: [latest], dropped: records.length - 1 }
  const kept = records.filter((r) => known.every((f) => r[f] !== undefined && r[f] === latest[f]))
  return { kept, dropped: records.length - kept.length }
}

const num = (v) => (typeof v === 'number' ? v : null)

/** 指標 1 件を、記録から読める形で計算する */
export function computeMetric({ metric, root, runs, read = readRecords }) {
  const file = metric.log.startsWith('logs/')
    ? path.join(logDirOf(root), path.posix.basename(metric.log))
    : path.join(root, metric.log)
  let records = read(file, Infinity)
  if (metric.filter) {
    records = records.filter((r) => r[metric.filter.field] === metric.filter.value)
  }
  if (records.length === 0) {
    return { id: metric.id, name: metric.name, kind: metric.kind, role: metric.role, groups: [], note: metric.note, empty: true }
  }

  // groupBy があるものは fixture セットごとに分ける（混ぜると別の問いの答えが 1 つになる）
  const groups = new Map()
  for (const r of records) {
    const key = metric.groupBy ? String(r[metric.groupBy] ?? '(不明)') : '全体'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const out = []
  for (const [key, rows] of groups) {
    // **同じ条件の回だけ**をばらつきの比較に使う（設計提案 3）。
    // 条件が違う回・条件が分からない古い記録は外し、外した件数を出す
    const { kept, dropped } = sameCondition(rows.slice(0, runs * 3), metric.conditionFields)
    const recent = kept.slice(0, runs)
    const droppedForCondition = dropped
    const latest = recent[0]
    let value = null
    let denominator = null
    let unmeasured = null
    let rates = []

    if (metric.percent) {
      value = num(latest[metric.percent])
      rates = recent.map((r) => num(r[metric.percent])).filter((v) => v !== null)
    } else if (metric.stateField) {
      // 状態の語で数える。**測れなかったを分母から消さない**
      const measured = recent.filter((r) => (metric.measuredStates ?? []).includes(r[metric.stateField])).length
      const un = recent.filter((r) => (metric.unmeasuredStates ?? []).includes(r[metric.stateField])).length
      value = measured
      denominator = measured + un
      unmeasured = un
      rates = denominator > 0 ? [Math.round((measured / denominator) * 1000) / 10] : []
    } else {
      value = num(latest[metric.numerator])
      denominator = num(latest[metric.denominator])
      unmeasured = metric.unmeasured ? num(latest[metric.unmeasured]) : null
      rates = recent
        .map((r) => {
          const n = num(r[metric.numerator])
          const d = num(r[metric.denominator])
          return n !== null && d ? Math.round((n / d) * 1000) / 10 : null
        })
        .filter((v) => v !== null)
    }

    out.push({
      key,
      value,
      denominator,
      unmeasured,
      at: latest.at ?? latest.timestamp ?? null,
      elapsedSeconds: latest.elapsedSeconds ?? null,
      model: latest.model ?? null,
      // 費用（2026-09-10）。**取れた回が無ければ欄そのものが無い**——
      // 0 円だったのか取れなかったのかを混ぜないため、undefined と 0 を区別する
      costUsd: typeof latest.costUsd === 'number' ? latest.costUsd : null,
      inputTokens: typeof latest.inputTokens === 'number' ? latest.inputTokens : null,
      outputTokens: typeof latest.outputTokens === 'number' ? latest.outputTokens : null,
      cacheReadTokens: typeof latest.cacheReadTokens === 'number' ? latest.cacheReadTokens : null,
      usageSamples: typeof latest.usageSamples === 'number' ? latest.usageSamples : null,
      usageMissing: typeof latest.usageMissing === 'number' ? latest.usageMissing : null,
      droppedForCondition,
      variance: spread(rates),
    })
  }
  return { id: metric.id, name: metric.name, kind: metric.kind, role: metric.role, groups: out, note: metric.note }
}

/** logs/ の置き場（worktree をまたいで共有される） */
export function logDirOf(root, run = execFileSync) {
  try {
    const common = String(
      run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }),
    ).trim()
    if (common) return path.join(path.dirname(common), 'logs')
  } catch {
    /* git が無ければ下へ */
  }
  return path.join(root, 'logs')
}

/**
 * 費用の 1 行分の文言（2026-09-10、設計提案 3「再現性と費用」）。
 *
 * WHY(取れなかったことを黙って 0 円にしない): eval はモックでも回る。
 *      モックの回は使用量を返さないので、そこを 0 円として混ぜると
 *      **費用が実際より安く見える**。取れた回数と取れなかった回数を別々に出す。
 */
export function costLabel(g) {
  const has = g.usageSamples !== null && g.usageSamples > 0
  if (has) {
    const parts = [`$${g.costUsd === null ? '?' : g.costUsd.toFixed(4)}`]
    if (g.inputTokens !== null || g.outputTokens !== null) {
      // WHY(キャッシュ分を別に出す): `input_tokens` はキャッシュから読んだ分を含まない。
      //      並べないと「入力 6 トークン」がプロンプト全体の大きさに読める（実測で
      //      入力 6 に対しキャッシュ読み 17,547 という回があった）。価格が違うので合算しない
      const cached = g.cacheReadTokens ? `（うちキャッシュ読み ${g.cacheReadTokens}）` : ''
      parts.push(`入力 ${g.inputTokens ?? '?'}${cached} / 出力 ${g.outputTokens ?? '?'} トークン`)
    }
    parts.push(`${g.usageSamples} 回分`)
    if (g.usageMissing) parts.push(`取れなかった ${g.usageMissing} 回は含まない`)
    return parts.join('・')
  }
  if (g.usageMissing !== null && g.usageMissing > 0) {
    // 0 円ではなく「取れなかった」。混ぜない
    return `費用は取れなかった（${g.usageMissing} 回。モック実行か古い形式）`
  }
  return null
}

export function render({ registry, root, runs }) {
  const lines = []
  const byKind = new Map()
  for (const m of registry.metrics ?? []) {
    if (!byKind.has(m.kind)) byKind.set(m.kind, [])
    byKind.get(m.kind).push(m)
  }
  let flakyCount = 0
  for (const [kind, metrics] of byKind) {
    lines.push(`## ${kind}`)
    for (const m of metrics) {
      const r = computeMetric({ metric: m, root, runs })
      if (r.empty) {
        lines.push(`  ${r.id} ${r.name}（${r.role}）: 記録が 1 行も無い（一度も測っていない）`)
        continue
      }
      for (const g of r.groups) {
        const label = g.key === '全体' ? '' : ` [${g.key}]`
        let body
        if (g.denominator === null) {
          body = `${g.value}%`
        } else {
          body = `${g.value} / ${g.denominator}`
          if (g.unmeasured) body += `（測れなかった ${g.unmeasured} 件を分母に残している）`
          else body += '（測れなかった 0 件）'
        }
        const extra = [
          g.model ? `モデル ${g.model}` : null,
          g.elapsedSeconds !== null ? `${g.elapsedSeconds} 秒` : null,
          costLabel(g),
        ].filter(Boolean)
        lines.push(
          `  ${r.id} ${r.name}${label}（${r.role}）: ${body}${g.at ? ` — ${g.at}` : ''}` +
            (extra.length > 0 ? `（${extra.join('・')}）` : ''),
        )
        const v = g.variance
        if (v.runs > 1) {
          const flag = v.flaky ? '**振れている**' : '安定'
          if (v.flaky) flakyCount++
          lines.push(`      同じ条件の直近 ${v.runs} 回: ${v.min}% 〜 ${v.max}%（幅 ${v.spread} ポイント。${flag}）`)
        } else {
          lines.push(`      同じ条件の回が ${v.runs} 回（ばらつきは 2 回以上でないと分からない）`)
        }
        if (g.droppedForCondition > 0) {
          // **黙って混ぜない。** 条件が違う回を同じばらつきに入れると、
          // モデルの揺れとコードの変更を区別できなくなる
          lines.push(`      条件が違う（または条件が記録に無い）${g.droppedForCondition} 回は比較から外した`)
        }
      }
      if (r.note) lines.push(`      ${r.note}`)
    }
    lines.push('')
  }
  lines.push(
    flakyCount > 0
      ? `**${flakyCount} 件が同条件で振れている。** その指標は 1 回の実行を合否に使えない（モデルの揺れを仕組みの劣化と読み違える）`
      : '同条件で振れている指標は無い（ただし記録が 1 回だけのものは判定できない）',
  )
  lines.push(
    '限界: 記録に残っている数字しか出せない。費用は `claude -p --output-format json` の ' +
      '`total_cost_usd`（表示価格ベース）で、**実際の請求とは一致しないことがある**。',
  )
  lines.push('　　　モックで回した eval からは費用が取れない。取れなかった回は 0 円として足さず、件数で出す。')
  lines.push('　　　ばらつきは**同じ条件の回だけ**で比べる。条件を記録していない古い回は比較から外れる。')
  return lines.join('\n')
}

function main(argv) {
  const o = { root: process.cwd(), runs: 5 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.root = argv[++i]
    else if (argv[i] === '--runs') o.runs = Number(argv[++i])
    else o.registry = argv[i]
  }
  if (!o.registry) {
    console.error('使い方: node scripts/lib/precision-metrics.mjs <registry.json> --root <repo> [--runs N]')
    process.exit(2)
  }
  const registry = JSON.parse(readFileSync(o.registry, 'utf8'))
  // 空振り防止: 登録簿を読めていないと「指標 0 件」で静かに通ってしまう
  if ((registry.metrics ?? []).length === 0) {
    console.error('precision-metrics: 登録簿に指標が 1 件も無い（読めていない疑い）')
    process.exit(1)
  }
  console.log(render({ registry, root: o.root, runs: o.runs }))
}

if (process.argv[1] && process.argv[1].endsWith('precision-metrics.mjs')) {
  main(process.argv.slice(2))
}
