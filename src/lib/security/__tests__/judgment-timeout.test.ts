// WHY: issue #757 の 31。判定の待ち時間に上限を付ける仕組みそのものを固定する。
//      確かめるのは 4 つ:
//        - 上限内なら本来の値をそのまま返す（速い経路に手を入れていない）
//        - 上限を超えたら代わりの値を返す（呼び出し側の分岐を増やさないための形）
//        - **諦めたことをログに残す**（無音で諦めると「拒否が増えた」としか読めない）
//        - 上限の値をコードに埋めず aidd.config.json から読む

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import limitsConfig from '../../../../aidd.config.json'
import { AUTH_JUDGMENT_TIMEOUT_MS, JudgmentTimeoutError, withJudgmentTimeout } from '../judgment-timeout'

describe('判定の待ち時間の上限（withJudgmentTimeout） [F-001][F-002][F-003]', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('上限は aidd.config.json の値を使う（コードに数字を埋めない）', () => {
    expect(AUTH_JUDGMENT_TIMEOUT_MS).toBe(limitsConfig.limits.authJudgmentTimeoutMs)
  })

  it('上限内に返れば、その値をそのまま返す', async () => {
    const p = withJudgmentTimeout('fast', async () => 'ok', () => 'fallback', 5000)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe('ok')
  })

  it('上限を超えたら代わりの値を返す（呼び出し側は同じ形を受け取る）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = withJudgmentTimeout('never', () => new Promise<string>(() => {}), () => 'fallback', 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toBe('fallback')
    spy.mockRestore()
  })

  it('諦めたらログに残す（黙って諦めない）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = withJudgmentTimeout('rpc.example', () => new Promise<string>(() => {}), () => 'x', 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(spy).toHaveBeenCalledTimes(1)
    const printed = JSON.stringify(spy.mock.calls)
    expect(printed).toContain('judgment-timeout')
    expect(printed).toContain('rpc.example')
    spy.mockRestore()
  })

  it('上限に達する前に返ったらタイマーを片付ける（残すとプロセスが終わらない）', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const p = withJudgmentTimeout('fast', async () => 1, () => 0, 5000)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(clear).toHaveBeenCalled()
  })

  it('印は型で見分けられる（拒否と「遅くて諦めた」を混ぜない）', () => {
    const e = new JudgmentTimeoutError('rpc.example', 5000)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('JudgmentTimeoutError')
    expect(e.label).toBe('rpc.example')
    expect(e.timeoutMs).toBe(5000)
  })
})
