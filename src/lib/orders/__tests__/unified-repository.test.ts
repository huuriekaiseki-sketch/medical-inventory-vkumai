import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchUnifiedOrders } from '@/lib/orders/unified-repository'
import type { CaseOrder, ConsumableOrder, LoanOrder, LoanReturn, OrdersFilter } from '@/types/order'

// issue #20 型安全・データ層整合レビュー対応（critical）:
// src/lib/orders/unified-repository.ts はSET-D中核の集約ロジック（並列取得・
// summaryLabel解決・displayDatetime降順の安定ソート・admin全施設ファンアウト）を
// 担うが、これまでroute.test.tsではfetchUnifiedOrders自体をモックしていたため
// 直接のユニットテストが1件も存在しなかった。ここで実装の中身を直接検証する。

const mockListCaseOrders = vi.fn()
const mockListConsumableOrders = vi.fn()
const mockListLoanOrders = vi.fn()
const mockListLoanReturns = vi.fn()
const mockListFacilities = vi.fn()

vi.mock('@/lib/case-orders/repository', () => ({
  listCaseOrders: (...args: unknown[]) => mockListCaseOrders(...args),
}))
vi.mock('@/lib/consumable-orders/repository', () => ({
  listConsumableOrders: (...args: unknown[]) => mockListConsumableOrders(...args),
}))
vi.mock('@/lib/loan-orders/repository', () => ({
  listLoanOrders: (...args: unknown[]) => mockListLoanOrders(...args),
}))
vi.mock('@/lib/loan-returns/repository', () => ({
  listLoanReturns: (...args: unknown[]) => mockListLoanReturns(...args),
}))
vi.mock('@/lib/facilities/repository', () => ({
  listFacilities: (...args: unknown[]) => mockListFacilities(...args),
}))

type QueryResult = { data: unknown; error: unknown }
type ChainableBuilder = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>

function makeChainable(result: QueryResult): ChainableBuilder {
  const builder = {} as ChainableBuilder
  const methods = ['select', 'in']
  for (const m of methods) {
    ;(builder as Record<string, unknown>)[m] = vi.fn(() => builder)
  }
  builder.then = ((resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)) as ChainableBuilder['then']
  return builder
}

function makeCaseOrder(overrides: Partial<CaseOrder> = {}): CaseOrder {
  return {
    id: 'co-1',
    facilityId: 'f-1',
    caseDatetime: '2026-07-10T00:00:00Z',
    procedureName: 'TAVI',
    patientId: 'P1',
    patientInitials: 'T.S.',
    gender: 'male',
    doctorName: '田中医師',
    status: 'submitted',
    items: [{ id: 'i-1', caseOrderId: 'co-1', jan: '490001', quantity: 1, createdAt: '2026-07-10T00:00:00Z' }],
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    ...overrides,
  }
}

function makeConsumableOrder(overrides: Partial<ConsumableOrder> = {}): ConsumableOrder {
  return {
    id: 'coo-1',
    facilityId: 'f-1',
    status: 'submitted',
    items: [{ id: 'i-1', consumableOrderId: 'coo-1', consumableId: 'c-1', quantity: 2, createdAt: '2026-07-09T00:00:00Z' }],
    createdAt: '2026-07-09T00:00:00Z',
    updatedAt: '2026-07-09T00:00:00Z',
    ...overrides,
  }
}

function makeLoanOrder(overrides: Partial<LoanOrder> = {}): LoanOrder {
  return {
    id: 'lo-1',
    facilityId: 'f-1',
    procedureName: 'TAVI',
    maker: 'メドトロニック',
    status: 'submitted',
    items: [{ id: 'i-1', loanOrderId: 'lo-1', name: 'カテーテルA', quantity: 1, createdAt: '2026-07-08T00:00:00Z' }],
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    ...overrides,
  }
}

function makeLoanReturn(overrides: Partial<LoanReturn> = {}): LoanReturn {
  return {
    id: 'lr-1',
    facilityId: 'f-1',
    returnDatetime: '2026-07-07T00:00:00Z',
    status: 'returned',
    items: [{ id: 'i-1', loanReturnId: 'lr-1', jan: '490002', quantity: 1, createdAt: '2026-07-07T00:00:00Z' }],
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    ...overrides,
  }
}

function makeDb(productsResult: QueryResult = { data: [], error: null }, consumablesResult: QueryResult = { data: [], error: null }): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      if (table === 'products') return makeChainable(productsResult)
      if (table === 'consumables') return makeChainable(consumablesResult)
      throw new Error(`unexpected table: ${table}`)
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListFacilities.mockResolvedValue([
    { id: 'f-1', name: '施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ])
  mockListCaseOrders.mockResolvedValue([])
  mockListConsumableOrders.mockResolvedValue([])
  mockListLoanOrders.mockResolvedValue([])
  mockListLoanReturns.mockResolvedValue([])
})

describe('fetchUnifiedOrders', () => {
  it('4種別すべて空の場合は { orders: [], errors: [] } を返す', async () => {
    const db = makeDb()
    const filter: OrdersFilter = { facilityId: 'f-1' }
    const result = await fetchUnifiedOrders(db, filter)
    expect(result).toEqual({ orders: [], errors: [] })
  })

  it('displayDatetime降順・同時刻はid昇順で4種別を安定ソートする', async () => {
    mockListCaseOrders.mockResolvedValue([makeCaseOrder({ id: 'co-1', caseDatetime: '2026-07-10T00:00:00Z' })])
    mockListConsumableOrders.mockResolvedValue([makeConsumableOrder({ id: 'coo-1', createdAt: '2026-07-09T00:00:00Z' })])
    mockListLoanOrders.mockResolvedValue([makeLoanOrder({ id: 'lo-1', createdAt: '2026-07-08T00:00:00Z' })])
    mockListLoanReturns.mockResolvedValue([makeLoanReturn({ id: 'lr-1', returnDatetime: '2026-07-07T00:00:00Z' })])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1' })

    expect(result.orders.map(o => o.id)).toEqual(['co-1', 'coo-1', 'lo-1', 'lr-1'])
    expect(result.orders.map(o => o.kind)).toEqual(['case', 'consumable', 'loan', 'loan_return'])
  })

  it('同時刻の場合はidの昇順で安定ソートする', async () => {
    const sameTime = '2026-07-10T00:00:00Z'
    mockListCaseOrders.mockResolvedValue([
      makeCaseOrder({ id: 'co-2', caseDatetime: sameTime }),
      makeCaseOrder({ id: 'co-1', caseDatetime: sameTime }),
    ])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: ['case'] })

    expect(result.orders.map(o => o.id)).toEqual(['co-1', 'co-2'])
  })

  it('orderKindsで指定した種別のみ取得する（未指定種別のlist関数は呼ばれない）', async () => {
    const db = makeDb()
    await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: ['case'] })

    expect(mockListCaseOrders).toHaveBeenCalled()
    expect(mockListConsumableOrders).not.toHaveBeenCalled()
    expect(mockListLoanOrders).not.toHaveBeenCalled()
    expect(mockListLoanReturns).not.toHaveBeenCalled()
  })

  // issue #20 レビュー指摘（important）回帰テスト: orderKindsが明示的な空配列（種別チェックボックスを
  // 全て外した状態）の場合、ALL_KINDSへフォールバックせず「0種別」として扱う（=いずれのlist関数も
  // 呼ばれず、結果は空になる）。undefined（パラメータ自体が未指定）の場合のみ全種別対象にする。
  it('orderKindsが明示的な空配列の場合は全種別にフォールバックせず、いずれのlist関数も呼ばない', async () => {
    mockListCaseOrders.mockResolvedValue([makeCaseOrder()])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: [] })

    expect(mockListCaseOrders).not.toHaveBeenCalled()
    expect(mockListConsumableOrders).not.toHaveBeenCalled()
    expect(mockListLoanOrders).not.toHaveBeenCalled()
    expect(mockListLoanReturns).not.toHaveBeenCalled()
    expect(result).toEqual({ orders: [], errors: [] })
  })

  it('1種別の取得が失敗しても他の結果は返しerrorsに理由を積む', async () => {
    mockListCaseOrders.mockRejectedValue(new Error('DB error'))
    mockListLoanOrders.mockResolvedValue([makeLoanOrder()])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1' })

    expect(result.errors).toEqual([{ kind: 'case', message: 'DB error' }])
    expect(result.orders).toHaveLength(1)
    expect(result.orders[0].kind).toBe('loan')
  })

  it('summaryLabelはproducts/consumablesから解決した代表製品名+残n件になる', async () => {
    mockListCaseOrders.mockResolvedValue([
      makeCaseOrder({
        items: [
          { id: 'i-1', caseOrderId: 'co-1', jan: '490001', quantity: 1, createdAt: '2026-07-10T00:00:00Z' },
          { id: 'i-2', caseOrderId: 'co-1', jan: '490002', quantity: 1, createdAt: '2026-07-10T00:00:00Z' },
        ],
      }),
    ])
    mockListConsumableOrders.mockResolvedValue([makeConsumableOrder()])
    const db = makeDb(
      { data: [{ jan: '490001', name: 'カテーテルA' }], error: null },
      { data: [{ id: 'c-1', name: 'ガーゼ' }], error: null }
    )

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: ['case', 'consumable'] })

    const caseOrder = result.orders.find(o => o.kind === 'case')!
    const consumableOrder = result.orders.find(o => o.kind === 'consumable')!
    expect(caseOrder.summaryLabel).toBe('カテーテルA 他1件')
    expect(consumableOrder.summaryLabel).toBe('ガーゼ')
  })

  it('品目が0件の場合は「(品目なし)」を表示する', async () => {
    mockListLoanOrders.mockResolvedValue([makeLoanOrder({ items: [] })])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: ['loan'] })

    expect(result.orders[0].summaryLabel).toBe('(品目なし)')
  })

  it('facilityNameはlistFacilitiesの結果から解決される', async () => {
    mockListCaseOrders.mockResolvedValue([makeCaseOrder({ facilityId: 'f-1' })])
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { facilityId: 'f-1', orderKinds: ['case'] })

    expect(result.orders[0].facilityName).toBe('施設A')
  })

  it('adminがfacility_id未指定の場合は全施設をファンアウトして種別ごとに上位20件へ絞り込む', async () => {
    mockListFacilities.mockResolvedValue([
      { id: 'f-1', name: '施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'f-2', name: '施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    mockListCaseOrders.mockImplementation((_db: unknown, facilityId: string) => {
      if (facilityId === 'f-1') return Promise.resolve([makeCaseOrder({ id: 'co-f1', facilityId: 'f-1', caseDatetime: '2026-07-10T00:00:00Z' })])
      if (facilityId === 'f-2') return Promise.resolve([makeCaseOrder({ id: 'co-f2', facilityId: 'f-2', caseDatetime: '2026-07-11T00:00:00Z' })])
      return Promise.resolve([])
    })
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { orderKinds: ['case'] })

    expect(mockListCaseOrders).toHaveBeenCalledTimes(2)
    expect(result.orders.map(o => o.id)).toEqual(['co-f2', 'co-f1'])
  })

  // issue #20 レビュー指摘（minor）回帰テスト: admin全施設ファンアウト時、displayDatetimeが
  // 完全一致する複数施設分のレコードが上位20件への切り詰め境界をまたぐ場合でも、idの昇順を
  // 第2キーとして安定的に切り詰めること（施設の列挙順や返却順に依存して結果が変わらないこと）。
  it('admin全施設ファンアウト時、同時刻タイが上位20件境界をまたいでもidを第2キーに決定的に切り詰める', async () => {
    mockListFacilities.mockResolvedValue([
      { id: 'f-1', name: '施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'f-2', name: '施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    const sameTime = '2026-07-10T00:00:00Z'
    // f-1（施設列挙順で先頭）からは辞書順で大きいid 'z-00' を1件、f-2からは辞書順で小さいid群
    // 'a-00'〜'a-19'（20件）を同時刻で返す。マージ後の配列は施設列挙順のまま [z-00, a-00, ..., a-19]
    // となるため、idタイブレークを使わず時刻のみでslice(0,20)すると（Array.sortの安定性により）
    // 元の並び順がそのまま残り、本来は辞書順で最小の20件（a-00〜a-19）が選ばれるべきところ、
    // 誤って z-00 を含み最後の a-19 を取りこぼす。idを第2キーに昇順ソートしてから切り詰めれば
    // 常に辞書順最小の20件（a-00〜a-19）が選ばれ、施設の列挙順・返却順に依存しない決定的な結果になる。
    mockListCaseOrders.mockImplementation((_db: unknown, facilityId: string) => {
      if (facilityId === 'f-1') {
        return Promise.resolve([makeCaseOrder({ id: 'z-00', facilityId: 'f-1', caseDatetime: sameTime })])
      }
      if (facilityId === 'f-2') {
        return Promise.resolve(
          Array.from({ length: 20 }, (_, i) =>
            makeCaseOrder({ id: `a-${String(i).padStart(2, '0')}`, facilityId: 'f-2', caseDatetime: sameTime })
          )
        )
      }
      return Promise.resolve([])
    })
    const db = makeDb()

    const result = await fetchUnifiedOrders(db, { orderKinds: ['case'] })

    expect(result.orders).toHaveLength(20)
    expect(result.orders.map(o => o.id)).not.toContain('z-00')
    expect(result.orders.map(o => o.id)).toContain('a-19')
  })
})
