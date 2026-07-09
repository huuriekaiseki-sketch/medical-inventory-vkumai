import { describe, expect, it } from 'vitest'
import { getPricing } from './model-pricing'

describe('getPricing', () => {
  it('known model名に対して単価を返す', () => {
    const pricing = getPricing('claude-opus-4-8')
    expect(pricing).not.toBeNull()
    expect(pricing?.inputPerMTok).toBeGreaterThan(0)
    expect(pricing?.outputPerMTok).toBeGreaterThan(pricing?.inputPerMTok ?? 0)
  })

  it('未知のモデル名にはnullを返す（fallbackで誤ったコストを計算しない）', () => {
    expect(getPricing('unknown-model-xyz')).toBeNull()
  })

  it('モデル名のバリエーション（バージョンサフィックス付き）も解決できる', () => {
    expect(getPricing('claude-haiku-4-5-20251001')).not.toBeNull()
  })

  it('sonnet-5は2026-08-31以前のtimestampでは導入価格を返す', () => {
    const pricing = getPricing('claude-sonnet-5', '2026-07-08T00:00:00.000Z')
    expect(pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 })
  })

  it('sonnet-5は2026-09-01以降のtimestampでは標準価格を返す', () => {
    const pricing = getPricing('claude-sonnet-5', '2026-09-02T00:00:00.000Z')
    expect(pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 })
  })

  it('sonnet-5でtimestamp省略時は標準価格（保守的フォールバック）を返す', () => {
    const pricing = getPricing('claude-sonnet-5')
    expect(pricing?.inputPerMTok).toBe(3)
  })
})
