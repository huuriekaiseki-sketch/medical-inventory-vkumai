import { describe, expect, it } from 'vitest'
import limitsConfig from '../../../../aidd.config.json'
import {
  caseOrderInputSchema,
  consumableOrderInputSchema,
  loanOrderInputSchema,
  loanReturnInputSchema,
} from '../schemas'
import { ORDER_ITEMS_MAX } from '../text-limits'

// WHY(issue #813): 発注 4 種（症例発注・短貸発注・短貸返却・消耗品発注）の明細は、文字数には上限があるのに
//      **件数には上限が無かった**（API・RPC・DB のどこにも）。1 回の登録で何万件でも受け取れ、
//      詳細ページ（issue #809）は 1 件の明細を全件そのまま表に出すので、応答も画面も際限なく大きくなる。
//      上限は人が決めた値（2026-09-20、AskUserQuestion で 100 件・4 種すべて）で、設定の 1 か所に置く。
const LIMIT = limitsConfig.limits.orderItemsMax

const FACILITY_ID = '11111111-1111-4111-8111-111111111111'

function janItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({ jan: `49000000${String(i).padStart(5, '0')}`, quantity: 1 }))
}

// 4 種それぞれの「明細以外は正しい入力」。items だけを差し替えて測る
const CASES = [
  {
    name: '症例発注',
    schema: caseOrderInputSchema,
    base: {
      facilityId: FACILITY_ID,
      caseDatetime: '2026-09-20T10:00',
      procedureName: 'テスト術式',
      patientId: 'P-001',
      patientInitials: 'T.T',
      gender: 'other',
      doctorName: 'テスト医師',
    },
    items: janItems,
  },
  {
    name: '短貸発注',
    schema: loanOrderInputSchema,
    base: { facilityId: FACILITY_ID, procedureName: 'テスト術式', maker: 'テストメーカー' },
    items: (n: number) => Array.from({ length: n }, (_, i) => ({ name: `品名${i}`, quantity: 1 })),
  },
  {
    name: '短貸返却',
    schema: loanReturnInputSchema,
    base: { facilityId: FACILITY_ID, returnDatetime: '2026-09-20T10:00' },
    items: janItems,
  },
  {
    name: '消耗品発注',
    schema: consumableOrderInputSchema,
    base: { facilityId: FACILITY_ID },
    items: (n: number) =>
      Array.from({ length: n }, () => ({ consumableId: '22222222-2222-4222-8222-222222222222', quantity: 1 })),
  },
] as const

describe('発注 4 種の明細の件数の上限（issue #813）', () => {
  it('上限は設定（aidd.config.json の limits.orderItemsMax）から読む', () => {
    expect(ORDER_ITEMS_MAX).toBe(LIMIT)
    expect(LIMIT).toBeGreaterThan(0)
  })

  for (const c of CASES) {
    describe(c.name, () => {
      it('対照: 明細 1 件の入力は通る（この後の「止まる」が、別の理由で落ちているのではないことを見る）', () => {
        const result = c.schema.safeParse({ ...c.base, items: c.items(1) })
        expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true)
      })

      it('ちょうど上限の件数は通る（境界の内側）', () => {
        expect(c.schema.safeParse({ ...c.base, items: c.items(LIMIT) }).success).toBe(true)
      })

      it('上限を 1 件超えると止まり、何件までかが伝わる', () => {
        const result = c.schema.safeParse({ ...c.base, items: c.items(LIMIT + 1) })
        expect(result.success).toBe(false)
        if (!result.success) {
          const messages = result.error.issues.map((i) => i.message)
          expect(messages).toContain(`明細は ${LIMIT} 件までです`)
        }
      })
    })
  }
})
