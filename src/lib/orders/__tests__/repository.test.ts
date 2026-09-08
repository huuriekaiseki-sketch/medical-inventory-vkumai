import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listOrders } from '@/lib/orders/repository'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChainableQuery(result: { data: unknown; error: unknown }): any {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => resolve(result),
  }
  return builder
}

type TableResults = Record<string, { data: unknown; error: unknown }>

// WHY: listOrders は case_orders/consumable_orders/loan_orders/loan_returns の
//      4テーブルへ個別にクエリするため、テーブル名ごとに異なる結果・builderを
//      返せるモックが必要。呼び出されたbuilderをテーブル名でも記録し、
//      個別クエリへのアサーション（limit(500)等）に使う
function makeMockOrdersDb(tableResults: TableResults): {
  db: SupabaseClient
  queries: Record<string, ReturnType<typeof makeChainableQuery>>
  from: ReturnType<typeof vi.fn>
} {
  const queries: Record<string, ReturnType<typeof makeChainableQuery>> = {}
  const from = vi.fn((table: string) => {
    const q = makeChainableQuery(tableResults[table] ?? { data: [], error: null })
    queries[table] = q
    return q
  })
  const db = { from } as unknown as SupabaseClient
  return { db, queries, from }
}

describe('listOrders', () => {
  const caseOrderRows = [
    {
      id: 'co-1', facility_id: 'f-1', procedure_name: 'TAVI', status: 'submitted',
      created_at: '2026-06-24T00:00:00Z',
      case_order_items: [{ jan: '111' }],
    },
  ]
  const consumableOrderRows = [
    {
      id: 'coo-1', facility_id: 'f-1', status: 'draft',
      created_at: '2026-06-23T00:00:00Z',
      consumable_order_items: [{ consumables: { name: 'シリンジ', jan: '222' } }, { consumables: { name: 'ガーゼ', jan: '333' } }],
    },
    {
      id: 'coo-2', facility_id: 'f-1', status: 'submitted',
      created_at: '2026-06-22T00:00:00Z',
      consumable_order_items: [],
    },
  ]
  // WHY(2026-09-08 に形が変わった): 「対応する返却が 0 件か」ではなく
  //      **明細ごとの残数**で未返却を判定するようになった（分割返却、20260908030000）。
  //      loan_returns の埋め込みは使わず、発注明細に紐付いた返却の数量を見る。
  const loanOrderRows = [
    {
      // 5 本借りて 2 本返した = 残り 3
      id: 'lo-1', facility_id: 'f-1', procedure_name: 'PCI', maker: 'メドトロニック', status: 'submitted',
      created_at: '2026-06-25T00:00:00Z',
      loan_order_items: [{ name: 'カテーテルA', quantity: 5, loan_return_items: [{ quantity: 2 }] }],
    },
    {
      // 2 本借りて 2 本返した = 残り 0
      id: 'lo-2', facility_id: 'f-1', procedure_name: 'CAG', maker: 'アボット', status: 'submitted',
      created_at: '2026-06-21T00:00:00Z',
      loan_order_items: [{ name: 'バルーンB', quantity: 2, loan_return_items: [{ quantity: 1 }, { quantity: 1 }] }],
    },
    {
      // draft なので残数に関わらず未返却にしない
      id: 'lo-3', facility_id: 'f-1', procedure_name: 'EVAR', maker: 'クック', status: 'draft',
      created_at: '2026-06-20T00:00:00Z',
      loan_order_items: [{ name: 'ステントC', quantity: 1, loan_return_items: [] }],
    },
  ]
  const loanReturnRows = [
    {
      id: 'lr-1', facility_id: 'f-1', status: 'returned', return_datetime: '2026-06-26T15:00:00Z',
      created_at: '2026-06-26T00:00:00Z',
      loan_return_items: [{ jan: '444' }],
    },
  ]

  function allTableResults(): TableResults {
    return {
      case_orders: { data: caseOrderRows, error: null },
      consumable_orders: { data: consumableOrderRows, error: null },
      loan_orders: { data: loanOrderRows, error: null },
      loan_returns: { data: loanReturnRows, error: null },
    }
  }

  it('kind未指定時は4種別すべてを createdAt 降順でマージして返す', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', {}, 50, 0)
    expect(result.map(o => o.id)).toEqual(['lr-1', 'lo-1', 'co-1', 'coo-1', 'coo-2', 'lo-2', 'lo-3'])
  })

  it('kind指定時は指定種別のみをクエリし、指定種別のみ返す', async () => {
    const { db, from } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'loan_order' }, 50, 0)
    expect(result.every(o => o.kind === 'loan_order')).toBe(true)
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('loan_orders')
  })

  // WHY: 受け入れ条件「自施設の発注のみが表示される（他施設の発注は表示されない）」について、
  //      各テーブルへのクエリが実際に .eq('facility_id', facilityId) で絞り込まれていることを
  //      検証するテストが存在しなかった（issue #20 レビュー指摘: 仕様カバレッジの穴）。
  //      モック上は他施設データが混ざっていても弾かれずに返ってしまうため、
  //      facility_id が各テーブルのクエリに正しく渡っていることを直接アサートする
  it('各テーブルへのクエリが facility_id で絞り込まれている（他施設データの越境防止）', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-1', {}, 50, 0)
    expect(queries.case_orders.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(queries.consumable_orders.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(queries.loan_orders.eq).toHaveBeenCalledWith('facility_id', 'f-1')
    expect(queries.loan_returns.eq).toHaveBeenCalledWith('facility_id', 'f-1')
  })

  it('kind指定時も対象テーブルのクエリがfacility_idで絞り込まれている', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-2', { kind: 'loan_order' }, 50, 0)
    expect(queries.loan_orders.eq).toHaveBeenCalledWith('facility_id', 'f-2')
  })

  it('各テーブルへのクエリに LIMIT 500 が付与されている', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-1', {}, 50, 0)
    expect(queries.case_orders.limit).toHaveBeenCalledWith(500)
    expect(queries.consumable_orders.limit).toHaveBeenCalledWith(500)
    expect(queries.loan_orders.limit).toHaveBeenCalledWith(500)
    expect(queries.loan_returns.limit).toHaveBeenCalledWith(500)
  })

  it('dateFrom/dateToがJSTの日境界でgte/lteに反映される', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-1', { kind: 'case_order', dateFrom: '2026-06-24', dateTo: '2026-06-25' }, 50, 0)
    expect(queries.case_orders.gte).toHaveBeenCalledWith('created_at', '2026-06-24T00:00:00+09:00')
    expect(queries.case_orders.lte).toHaveBeenCalledWith('created_at', '2026-06-25T23:59:59.999999+09:00')
  })

  it('keywordがconsumable_orderの場合は消耗品名で一致する', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'consumable_order', keyword: 'シリンジ' }, 50, 0)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('coo-1')
    expect(result[0].summary).toBe('シリンジ、ガーゼ')
  })

  // WHY: keywordの絞り込みはSet Cの仕様上、種別ごとに対象列が異なる
  //      (case_order: procedure_name/items[].jan, loan_order: procedure_name/maker/items[].name,
  //      loan_return: items[].jan) にもかかわらず、consumable_orderのみテストされておらず
  //      実装差分の主要機能の一部が未検証だった（issue #20 レビュー指摘: 仕様カバレッジの穴）。
  //      残り3種別についてもkeyword絞り込みを検証する
  it('keywordがcase_orderの場合はprocedure_nameで一致する', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'case_order', keyword: 'TAVI' }, 50, 0)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('co-1')
  })

  it('keywordがcase_orderの場合はitems[].janでも一致する', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'case_order', keyword: '111' }, 50, 0)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('co-1')
  })

  it('keywordがcase_orderのどの対象列にも一致しない場合は0件になる', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'case_order', keyword: '一致しないキーワード' }, 50, 0)
    expect(result).toHaveLength(0)
  })

  it('keywordがloan_orderの場合はprocedure_name/maker/items[].nameのいずれかで一致する', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const byProcedure = await listOrders(db, 'f-1', { kind: 'loan_order', keyword: 'PCI' }, 50, 0)
    expect(byProcedure.map(o => o.id)).toEqual(['lo-1'])

    const byMaker = await listOrders(db, 'f-1', { kind: 'loan_order', keyword: 'アボット' }, 50, 0)
    expect(byMaker.map(o => o.id)).toEqual(['lo-2'])

    const byItemName = await listOrders(db, 'f-1', { kind: 'loan_order', keyword: 'カテーテルA' }, 50, 0)
    expect(byItemName.map(o => o.id)).toEqual(['lo-1'])
  })

  it('keywordがloan_returnの場合はitems[].janで一致する', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'loan_return', keyword: '444' }, 50, 0)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lr-1')
  })

  it('keywordがloan_returnのどの対象列にも一致しない場合は0件になる', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'loan_return', keyword: '一致しないキーワード' }, 50, 0)
    expect(result).toHaveLength(0)
  })

  it('consumable_orderで消耗品名が1件も取れない場合は品目数フォールバックのsummaryになる', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'consumable_order' }, 50, 0)
    const coo2 = result.find(o => o.id === 'coo-2')
    expect(coo2?.summary).toBe('消耗品 0 品目')
  })

  it('unreturned: true になる行 = submitted かつ 残数がある loan_order のみ（残数も返す）', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'loan_order' }, 50, 0)
    const lo1 = result.find(o => o.id === 'lo-1')
    const lo2 = result.find(o => o.id === 'lo-2')
    const lo3 = result.find(o => o.id === 'lo-3')
    expect(lo1?.unreturned).toBe(true)
    expect(lo1?.outstandingQuantity, '5 本のうち 2 本返したので残り 3').toBe(3)
    expect(lo2?.unreturned).toBe(false)
    expect(lo2?.outstandingQuantity, '2 本を 1 本ずつ 2 回で返しきった').toBe(0)
    expect(lo3?.unreturned, 'draft は未返却にしない').toBe(false)
  })

  it('loan_returnのsummaryは返却日時のJST日付になる（UTC 15:00 = JST 翌日 0:00。issue #757 の 15）', async () => {
    // WHY: 以前は期待値を実装と同じ式（環境のタイムゾーンで整形）で作っていたため、
    //      Vercel（UTC）で前日になる不具合をテストが見逃していた。JST の日付を文字列で固定する
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', { kind: 'loan_return' }, 50, 0)
    expect(result[0].summary).toBe('返却 2026/6/27')
  })

  it('kind指定かつoffset+limitが500を超える場合、LIMITはoffset+limitまで引き上げられる（ページング破綻の修正）', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-1', { kind: 'loan_order' }, 50, 600)
    expect(queries.loan_orders.limit).toHaveBeenCalledWith(650)
  })

  it('offset+limitが500以下の場合はLIMIT 500のまま（既存挙動維持）', async () => {
    const { db, queries } = makeMockOrdersDb(allTableResults())
    await listOrders(db, 'f-1', { kind: 'loan_order' }, 50, 100)
    expect(queries.loan_orders.limit).toHaveBeenCalledWith(500)
  })

  it('offset/limitで全種別マージ後にスライスする', async () => {
    const { db } = makeMockOrdersDb(allTableResults())
    const result = await listOrders(db, 'f-1', {}, 2, 1)
    expect(result.map(o => o.id)).toEqual(['lo-1', 'co-1'])
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { db } = makeMockOrdersDb({
      case_orders: { data: null, error: { message: 'DB error' } },
      consumable_orders: { data: [], error: null },
      loan_orders: { data: [], error: null },
      loan_returns: { data: [], error: null },
    })
    await expect(listOrders(db, 'f-1', {}, 50, 0)).rejects.toThrow('DB error')
  })
})
