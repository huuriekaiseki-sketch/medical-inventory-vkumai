// 毎回落ちるテスト（揺れではなくバグ、として分類されることの確認用）。
// FLAKY_FIXTURE_ALWAYS_FAIL=1 のときだけ落ちる（既定は通る）
import { describe, expect, it } from 'vitest'

describe('fixture: always-fail', () => {
  it('FLAKY_FIXTURE_ALWAYS_FAIL=1 なら毎回落ちる', () => {
    expect(process.env.FLAKY_FIXTURE_ALWAYS_FAIL).not.toBe('1')
  })
})
