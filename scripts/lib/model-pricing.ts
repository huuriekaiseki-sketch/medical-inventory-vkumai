export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

// 単価は100万トークンあたりのUSD。出典: https://platform.claude.com/docs/en/about-claude/pricing（2026-07-09取得）
const SONNET_5_INTRO_CUTOFF = '2026-09-01T00:00:00Z'
const SONNET_5_INTRO: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 }
const SONNET_5_STANDARD: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 }

const STATIC_PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
}

export function getPricing(model: string, atISOTimestamp?: string): ModelPricing | null {
  if (model === 'claude-sonnet-5') {
    // timestamp省略時は標準価格（高い方）を返し、コストを過小評価しない
    const at = atISOTimestamp ?? SONNET_5_INTRO_CUTOFF
    return at < SONNET_5_INTRO_CUTOFF ? SONNET_5_INTRO : SONNET_5_STANDARD
  }
  return STATIC_PRICING_TABLE[model] ?? null
}
