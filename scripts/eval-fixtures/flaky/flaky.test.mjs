// 決定的に「揺れる」テスト（RED 方向 fixture）。FLAKY_FIXTURE_STATE のファイルに実行回数を記録し、
// 1 回目だけ落ちて 2 回目以降は通る。実行順に依存する flaky の最小モデル。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('fixture: flaky', () => {
  it('1 回目は落ち、2 回目以降は通る', () => {
    const state = process.env.FLAKY_FIXTURE_STATE
    if (!state) throw new Error('FLAKY_FIXTURE_STATE が未設定')
    const n = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0
    writeFileSync(state, String(n + 1))
    expect(n).toBeGreaterThan(0)
  })
})
