import { describe, it, expect } from 'vitest'
import { computeDivergence } from '../judge-panel.js'

describe('computeDivergence', () => {
  it('提案が1件のみならhasDivergenceはfalse', () => {
    const result = computeDivergence([
      { keyDecisions: ['在庫データをリアルタイムで同期する'] },
    ])
    expect(result.hasDivergence).toBe(false)
  })

  it('keyDecisionsが空ならdivergenceRatioは0でhasDivergenceはfalse', () => {
    const result = computeDivergence([{ keyDecisions: [] }, { keyDecisions: [] }])
    expect(result.divergenceRatio).toBe(0)
    expect(result.hasDivergence).toBe(false)
  })

  it('語尾・助詞が違うだけの言い換えは重複とみなしhasDivergenceはfalse（issue #295: 完全一致判定だと常にtrueになっていた、3提案が実運用のPROPOSERS数）', () => {
    const result = computeDivergence([
      { keyDecisions: ['在庫データをリアルタイムで同期する', '施設ごとにテーブルを分離する'] },
      { keyDecisions: ['在庫データをリアルタイムに同期させる', '施設ごとにテーブルを分ける'] },
      { keyDecisions: ['在庫データをリアルタイムに同期する', '施設ごとにテーブルを分離しておく'] },
    ])
    expect(result.hasDivergence).toBe(false)
  })

  it('明らかに異なる設計判断が多い場合はhasDivergenceがtrue', () => {
    const result = computeDivergence([
      { keyDecisions: ['在庫データをリアルタイムで同期する', '施設ごとにテーブルを分離する'] },
      { keyDecisions: ['夜間バッチでまとめて在庫を更新する', '全施設共通の単一テーブルをRLSで分離する'] },
      { keyDecisions: ['外部倉庫システムに在庫管理ごと委託する', '施設概念を廃止して単一在庫プールにする'] },
    ])
    expect(result.hasDivergence).toBe(true)
  })

  it('完全一致の文字列は同一クラスタとして扱われる', () => {
    const result = computeDivergence([
      { keyDecisions: ['同じ判断', '同じ判断'] },
      { keyDecisions: ['同じ判断'] },
    ])
    expect(result.divergenceRatio).toBeCloseTo(1 / 3)
    expect(result.hasDivergence).toBe(false)
  })
})
