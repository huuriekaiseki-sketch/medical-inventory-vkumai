import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLoanReturn, listLoanReturns } from '@/lib/loan-returns/repository'

// issue #20 SET-C: 複数ステップのSupabaseクエリ（.select().eq().gte()...）をチェーン可能な
// モックとして表現するヘルパー。各メソッドは同一builderを返し、awaitされた時点で
// resultをdata/errorとして解決する（実際のsupabase-jsのPostgrestFilterBuilderと同じ振る舞い）
type QueryResult = { data: unknown; error: unknown }
type ChainableBuilder = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>

function makeChainable(result: QueryResult): ChainableBuilder {
  const builder = {} as ChainableBuilder
  const methods = ['select', 'eq', 'gte', 'lte', 'ilike', 'in', 'order', 'range']
  for (const m of methods) {
    ;(builder as Record<string, unknown>)[m] = vi.fn(() => builder)
  }
  builder.then = ((resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)) as ChainableBuilder['then']
  return builder
}

describe('createLoanReturn', () => {
  const mockReturn = {
    id: 'lr-1', facility_id: 'f-1', return_datetime: '2026-06-24T15:00:00Z',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', loan_return_id: 'lr-1', jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
  ]

  it('ヘッダーと明細を作成してLoanReturnを返す', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_returns') {
          return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockReturn, error: null }) })) })) }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    const result = await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })
    expect(result.id).toBe('lr-1')
    expect(result.status).toBe('draft')
    expect(result.items[0].jan).toBe('490001')
  })

  it('DBのstatusが想定外の値の場合はdraftにフォールバックする', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'loan_returns') {
          return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { ...mockReturn, status: 'invalid' }, error: null }) })) })) }
        }
        if (table === 'loan_return_items') {
          return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
        }
      }),
    } as unknown as SupabaseClient

    const result = await createLoanReturn(db, 'f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })
    expect(result.status).toBe('draft')
  })
})

// issue #20 SET-C: listLoanReturns への dateFrom/dateTo/productSearch フィルタ拡張
describe('listLoanReturns', () => {
  const mockRow = {
    id: 'lr-1', facility_id: 'f-1', return_datetime: '2026-06-24T15:00:00Z',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
    loan_return_items: [],
  }

  // issue #20 型安全・データ層整合レビュー対応（critical）: dateFrom/dateTo は return_datetime で
  // 絞り込むため、.order() も created_at ではなく return_datetime でなければ、施設ごとの
  // 該当件数が limit を超えた場合にDB側で誤ったキーで先に切り詰められるバグになる
  it('facility_id で絞り込み、return_datetime 降順・id昇順で limit/offset の範囲を取得する', async () => {
    const returnsBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => returnsBuilder) } as unknown as SupabaseClient

    const result = await listLoanReturns(db, 'f-1', 50, 0)

    expect(db.from).toHaveBeenCalledWith('loan_returns')
    expect(returnsBuilder.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(returnsBuilder.order).toHaveBeenCalledWith('return_datetime', { ascending: false })
    expect(returnsBuilder.order).toHaveBeenCalledWith('id', { ascending: true })
    expect(returnsBuilder.range).toHaveBeenCalledWith(0, 49)
    expect(result).toHaveLength(1)
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(loan_return_items(...))に明示的な
  // ORDER BY が無いと代表製品名の選出が理論上非決定的になる。作成順（created_at昇順・
  // id昇順を第2キー）を明示することで「最初に登録した明細」を安定して代表として選出する
  it('loan_return_items（埋め込み）にcreated_at昇順・id昇順の明示的なORDER BYを指定する', async () => {
    const returnsBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => returnsBuilder) } as unknown as SupabaseClient

    await listLoanReturns(db, 'f-1', 50, 0)

    expect(returnsBuilder.order).toHaveBeenCalledWith('created_at', {
      ascending: true,
      referencedTable: 'loan_return_items',
    })
    expect(returnsBuilder.order).toHaveBeenCalledWith('id', {
      ascending: true,
      referencedTable: 'loan_return_items',
    })
  })

  // issue #20 型安全・データ層整合レビュー対応（important）: SPEC.md Part2 SET-C テスト観点
  // 「limit上限: 最大100（100超は400エラー）、負数は400エラー」の未実装・未テストを解消
  it('limitが100を超える場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listLoanReturns(db, 'f-1', 101, 0)).rejects.toThrow('limit は 1〜100 の整数で指定してください')
  })

  it('offsetが負数の場合はエラーを投げる', async () => {
    const db = { from: vi.fn() } as unknown as SupabaseClient
    await expect(listLoanReturns(db, 'f-1', 50, -1)).rejects.toThrow('offset は0以上の整数で指定してください')
  })

  it('dateFrom/dateTo を指定すると return_datetime に gte/lte を適用する', async () => {
    const returnsBuilder = makeChainable({ data: [mockRow], error: null })
    const db = { from: vi.fn(() => returnsBuilder) } as unknown as SupabaseClient

    await listLoanReturns(db, 'f-1', 50, 0, { dateFrom: '2026-06-01T00:00:00Z', dateTo: '2026-06-30T23:59:59Z' })

    expect(returnsBuilder.gte).toHaveBeenCalledWith('return_datetime', '2026-06-01T00:00:00Z')
    expect(returnsBuilder.lte).toHaveBeenCalledWith('return_datetime', '2026-06-30T23:59:59Z')
  })

  it('productSearch が空文字/未指定の場合は products / loan_return_items を問い合わせない', async () => {
    const returnsBuilder = makeChainable({ data: [mockRow], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'loan_returns') return returnsBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    await listLoanReturns(db, 'f-1', 50, 0, { productSearch: '' })

    expect(from).toHaveBeenCalledTimes(1)
  })

  it('productSearch を指定すると products→loan_return_items 経由で対象IDを絞り込む', async () => {
    const productsBuilder = makeChainable({ data: [{ jan: '490001' }], error: null })
    const itemsBuilder = makeChainable({ data: [{ loan_return_id: 'lr-1' }], error: null })
    const returnsBuilder = makeChainable({ data: [mockRow], error: null })
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return productsBuilder
        if (table === 'loan_return_items') return itemsBuilder
        if (table === 'loan_returns') return returnsBuilder
        throw new Error(`unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await listLoanReturns(db, 'f-1', 50, 0, { productSearch: 'カテーテル' })

    expect(productsBuilder.select).toHaveBeenCalledWith('jan')
    expect(productsBuilder.ilike).toHaveBeenCalledWith('name', '%カテーテル%')
    expect(itemsBuilder.in).toHaveBeenCalledWith('jan', ['490001'])
    expect(returnsBuilder.in).toHaveBeenCalledWith('id', ['lr-1'])
    expect(result).toHaveLength(1)
  })

  it('productSearch にヒットする製品が無い場合は空配列を返す', async () => {
    const productsBuilder = makeChainable({ data: [], error: null })
    const from = vi.fn((table: string) => {
      if (table === 'products') return productsBuilder
      throw new Error(`unexpected table: ${table}`)
    })
    const db = { from } as unknown as SupabaseClient

    const result = await listLoanReturns(db, 'f-1', 50, 0, { productSearch: 'ヒットしない' })

    expect(result).toEqual([])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('Supabaseエラー時に例外を投げる（メインクエリ）', async () => {
    const returnsBuilder = makeChainable({ data: null, error: { message: 'DB error' } })
    const db = { from: vi.fn(() => returnsBuilder) } as unknown as SupabaseClient

    await expect(listLoanReturns(db, 'f-1', 50, 0)).rejects.toThrow('DB error')
  })
})
