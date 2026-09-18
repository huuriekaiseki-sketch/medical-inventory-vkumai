import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { parseScore, validateRows, summarize, decide, LAYERS, VERDICTS, SCORE_FILE } from '../check-harness-score.mjs'

// WHY: 2026-09-15。ハーネスの成績（止めた / 見逃した / 邪魔した）を機械可読にした。
//      固定するのは (1) 実物の記録が形と語彙に収まっていること、(2) 形を外した行を名指しで落とせること
//      （RED 方向。C-022）、(3) 仕分けの規則（残す / 直すか外す / 削る）が人の決めたとおりであること。
//      中身が本当に起きたことかは見ない（自己申告。docs/agents/harness-score.md の限界）。

const ROOT = path.resolve(__dirname, '../../..')

describe('ハーネスの成績（harness-score.jsonl）の形と語彙', () => {
  it('実物の記録は形・語彙・参照先の実在に収まっている', () => {
    const file = path.join(ROOT, SCORE_FILE)
    expect(existsSync(file), `${SCORE_FILE} が無い`).toBe(true)
    const { rows, errors } = parseScore(readFileSync(file, 'utf8'))
    expect(errors).toEqual([])
    expect(rows.length, '記録が 1 行も無い（走査の空振り）').toBeGreaterThan(0)
    expect(validateRows(rows, { root: ROOT })).toEqual([])
  })

  it('形を外した行を、行番号つきで名指しする（RED 方向）', () => {
    const good = {
      date: '2026-09-13', repo: 'x', issue: 'i', component: 'Coverage Check', layer: 'core',
      verdict: 'stopped', detail: 'd', ref: 'package.json',
    }
    const lines = [
      JSON.stringify(good),
      JSON.stringify({ ...good, layer: 'shared' }),
      JSON.stringify({ ...good, verdict: 'passed' }),
      JSON.stringify({ ...good, detail: '' }),
      JSON.stringify({ ...good, date: '2026/09/13' }),
      JSON.stringify({ ...good, ref: 'docs/no-such-file.md' }),
      JSON.stringify({ ...good, cost: { hours: 1 } }),
      JSON.stringify({ ...good, cost: { minutes: -5 } }),
      '{ not json',
    ]
    const { rows, errors: parseErrors } = parseScore(lines.join('\n'))
    const errors = [...parseErrors, ...validateRows(rows, { root: ROOT })]
    expect(errors).toHaveLength(8)
    expect(errors.join('\n')).toMatch(/line 2: layer は core \/ adapter \/ consumer/)
    expect(errors.join('\n')).toMatch(/line 3: verdict は stopped \/ missed \/ obstructed/)
    expect(errors.join('\n')).toMatch(/line 4: detail が無いか空/)
    expect(errors.join('\n')).toMatch(/line 5: date は YYYY-MM-DD/)
    expect(errors.join('\n')).toMatch(/line 6: ref の実体が無い/)
    expect(errors.join('\n')).toMatch(/line 7: cost\.hours は知らない鍵/)
    expect(errors.join('\n')).toMatch(/line 8: cost\.minutes は 0 以上の数/)
    expect(errors.join('\n')).toMatch(/line 9: JSON として読めない/)
  })

  it('語彙は 3 語ずつ（増やすときはこのテストと文書を同時に直す）', () => {
    expect(LAYERS).toEqual(['core', 'adapter', 'consumer'])
    expect(VERDICTS).toEqual(['stopped', 'missed', 'obstructed'])
  })

  it('仕分けの規則: 止めたがあれば残す、見逃しだけなら直すか外す、邪魔しただけなら削る', () => {
    const rows = [
      { component: 'A', layer: 'core', verdict: 'stopped', cost: { minutes: 3 } },
      { component: 'A', layer: 'core', verdict: 'obstructed', cost: { minutes: 30 } },
      { component: 'B', layer: 'core', verdict: 'missed' },
      { component: 'C', layer: 'adapter', verdict: 'obstructed' },
      { component: 'D', layer: 'consumer', verdict: 'stopped' },
    ]
    const table = summarize(rows as never)
    const byName = Object.fromEntries(table.map((e) => [e.component, e]))
    expect(decide(byName.A)).toBe('keep(costly)')
    expect(byName.A.minutes).toBe(33)
    expect(decide(byName.B)).toBe('fix-or-drop')
    expect(decide(byName.C)).toBe('drop')
    expect(decide(byName.D)).toBe('keep')
  })

  it('同じ部品でも層が違えば別に数える（導入先の都合で共通側を削らないため）', () => {
    const rows = [
      { component: 'warn', layer: 'core', verdict: 'stopped' },
      { component: 'warn', layer: 'consumer', verdict: 'obstructed' },
    ]
    const table = summarize(rows as never)
    expect(table).toHaveLength(2)
    expect(decide(table.find((e) => e.layer === 'core')!)).toBe('keep')
    expect(decide(table.find((e) => e.layer === 'consumer')!)).toBe('drop')
  })
})
