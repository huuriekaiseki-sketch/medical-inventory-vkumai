import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { searchLotItems, LOT_SEARCH_LIMIT } from '@/lib/lot-search/repository'
import { buildIlikeValueUnquoted } from '@/lib/search/like-pattern'

type QueryResult = { data: unknown; error: unknown }

// WHY(any を使わない): 実物の型（PostgrestFilterBuilder）はジェネリクスが深くモックでは再現できないが、
//      このテストが使うのは「6 つのメソッドが自分自身を返すこと」と「await できること」だけ。
//      その形だけを型にすれば足りる。最初は戻り値を any にして lint の無効化コメントを足していたが、
//      逃がし口の上限（scripts/check-exemptions.test.sh）を 1 件超えて CI が落ちた。上限を上げずに逃がし口を消した。
//      （この検査はコメントの中の文字列も数えるので、ここに無効化コメントの綴りそのものを書かないこと）
type ChainMethod = ReturnType<typeof vi.fn<(...args: unknown[]) => ChainableQuery>>
type ChainableQuery = {
  select: ChainMethod
  eq: ChainMethod
  not: ChainMethod
  ilike: ChainMethod
  order: ChainMethod
  limit: ChainMethod
  then: (resolve: (value: QueryResult) => unknown) => unknown
}

function makeChainableQuery(result: QueryResult): ChainableQuery {
  const builder: ChainableQuery = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    not: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve) => resolve(result),
  }
  return builder
}

type TableResults = Record<string, QueryResult>

function makeMockDb(tableResults: TableResults): {
  db: SupabaseClient
  queries: Record<string, ReturnType<typeof makeChainableQuery>>
} {
  const queries: Record<string, ReturnType<typeof makeChainableQuery>> = {}
  const from = vi.fn((table: string) => {
    const q = makeChainableQuery(tableResults[table] ?? { data: [], error: null })
    queries[table] = q
    return q
  })
  const db = { from } as unknown as SupabaseClient
  return { db, queries }
}

function emptyResults(): TableResults {
  return {
    case_order_items: { data: [], error: null },
    loan_return_items: { data: [], error: null },
  }
}

describe('searchLotItems（issue #803 Set A: P-013/P-015 明細の施設境界に準ずる横断検索）', () => {
  it('case_order_items と loan_return_items の両方を occurredAt 降順でマージして返す', async () => {
    const { db } = makeMockDb({
      case_order_items: {
        data: [
          {
            id: 'coi-1', case_order_id: 'co-1', jan: '111', lot: 'LOT-A', quantity: 2,
            case_orders: { facility_id: 'f-1', case_datetime: '2026-09-01T00:00:00Z' },
          },
        ],
        error: null,
      },
      loan_return_items: {
        data: [
          {
            id: 'lri-1', loan_return_id: 'lr-1', jan: '222', lot: 'LOT-A', quantity: 1,
            loan_returns: { facility_id: 'f-1', return_datetime: '2026-09-05T00:00:00Z' },
          },
        ],
        error: null,
      },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.truncated).toBe(false)
    expect(result.items.map(i => i.itemId)).toEqual(['lri-1', 'coi-1'])
    expect(result.items[0]).toEqual({
      kind: 'loan_return',
      itemId: 'lri-1',
      parentId: 'lr-1',
      lot: 'LOT-A',
      jan: '222',
      quantity: 1,
      occurredAt: '2026-09-05T00:00:00Z',
      cancelled: false,
    })
  })

  it('親テーブルを !inner 結合し、facility_id で明示的に絞り込む（RLS だけに頼らない。admin のクライアントでも越境しない）', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.select).toHaveBeenCalledWith(
      expect.stringContaining('case_orders!inner(facility_id, case_datetime')
    )
    expect(queries.case_order_items.eq).toHaveBeenCalledWith('case_orders.facility_id', 'f-1')
    expect(queries.loan_return_items.select).toHaveBeenCalledWith(
      expect.stringContaining('loan_returns!inner(facility_id, return_datetime')
    )
    expect(queries.loan_return_items.eq).toHaveBeenCalledWith('loan_returns.facility_id', 'f-1')
  })

  // WHY(レビュー指摘の修正): 各テーブルの .order() は最終マージの並び替え基準（occurredAt）と
  //      同じ列で並べる必要がある。created_at など別の列で並べると「各テーブル単体で LIMIT+1
  //      件取れば、マージ後の上位 LIMIT+1 件を取りこぼさない」という truncated 判定の前提が
  //      崩れる（テーブル内の並び順と最終的な並び順が食い違うと、本来上位に入るはずの行が
  //      LIMIT+1 件の外に切り落とされうる）。
  it('各テーブルの order は occurredAt と同じ列（case_datetime / return_datetime）で並べる', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.order).toHaveBeenCalledWith(
      'case_datetime',
      expect.objectContaining({ referencedTable: 'case_orders', ascending: false })
    )
    expect(queries.loan_return_items.order).toHaveBeenCalledWith(
      'return_datetime',
      expect.objectContaining({ referencedTable: 'loan_returns', ascending: false })
    )
  })

  it('lot IS NOT NULL を明示する（NULL LIKE は UNKNOWN で黙って外れるため、意図をコードでも固定する）', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    expect(queries.case_order_items.not).toHaveBeenCalledWith('lot', 'is', null)
    expect(queries.loan_return_items.not).toHaveBeenCalledWith('lot', 'is', null)
  })

  it('検索語は buildIlikeValueUnquoted でエスケープしてから ilike に渡す（%・_・"・,・( を含む検索語）', async () => {
    const { db, queries } = makeMockDb(emptyResults())
    const tricky = '%_A",(B'

    await searchLotItems(db, 'f-1', tricky)

    const expected = buildIlikeValueUnquoted(tricky)
    expect(queries.case_order_items.ilike).toHaveBeenCalledWith('lot', expected)
    expect(queries.loan_return_items.ilike).toHaveBeenCalledWith('lot', expected)
    // ワイルドカードとして働かない = エスケープ後の値は元の '%' そのままではない（% 自体はエスケープ済み）
    expect(expected).not.toBe(`%${tricky}%`)
  })

  // WHY(決定 6 を 2026-09-19 に (a)→(b) へ決め直した): 最初は「一覧に患者の情報を出さない。発注を開けば分かる」で
  //      承認されたが、**発注の詳細ページは存在せず**、患者の情報が登録後に出る画面は 1 つも無かった（停止②で判明）。
  //      リコール対応の目的は「どの患者に使ったか」の特定なので、症例発注の行に**患者 ID とイニシャルだけ**を出す。
  //      施設のメンバーは既存の一覧 API（/api/case-orders）で同じ情報を受け取れるので、見える人は増えない。
  //      特定に要らないもの（医師名・性別・術式名）は出さない。下の 2 本が「出すもの」と「出さないもの」の両方を固定する
  it('症例発注の行は患者 ID とイニシャルを持ち、キーは決めた集合と完全一致する（医師名・性別・術式名が紛れ込んだら落ちる）', async () => {
    const { db } = makeMockDb({
      case_order_items: {
        data: [
          {
            id: 'coi-1', case_order_id: 'co-1', jan: '111', lot: 'LOT-A', quantity: 2,
            case_orders: {
              facility_id: 'f-1', case_datetime: '2026-09-01T00:00:00Z',
              patient_id: 'P-0001', patient_initials: 'T.Y.',
              // 問い合わせていないはずの列が返ってきても、戻り値には写さないこと
              doctor_name: 'Dr. X', gender: 'male', procedure_name: 'PCI',
            },
          },
        ],
        error: null,
      },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items[0]).toMatchObject({ kind: 'case_order', patientId: 'P-0001', patientInitials: 'T.Y.', cancelled: false })
    expect(Object.keys(result.items[0]).sort()).toEqual(
      ['kind', 'itemId', 'parentId', 'lot', 'jan', 'quantity', 'occurredAt', 'patientId', 'patientInitials', 'cancelled'].sort()
    )
    const json = JSON.stringify(result)
    expect(json).not.toContain('Dr. X')
    expect(json).not.toContain('PCI')
  })

  // WHY(issue #824): 症例発注の取り消しは親の1段のみ（case_orders.status）。短貸返却の2段判定
  //      （明細ごと/回ごとのOR）を症例発注に書かないことを対照ケースで固定する
  it.each([
    ['取り消し済み', 'cancelled', true],
    ['提出済み（取り消していない）', 'submitted', false],
    ['下書き（取り消していない）', 'draft', false],
  ])('症例発注の取り消し状態を case_orders.status の1段だけで判定する: %s', async (_name, status, expected) => {
    const { db } = makeMockDb({
      case_order_items: {
        data: [
          {
            id: 'coi-1', case_order_id: 'co-1', jan: '111', lot: 'LOT-A', quantity: 2,
            case_orders: {
              facility_id: 'f-1', case_datetime: '2026-09-01T00:00:00Z',
              patient_id: 'P-0001', patient_initials: 'T.Y.', status,
            },
          },
        ],
        error: null,
      },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ kind: 'case_order', cancelled: expected })
  })

  // WHY(status を名指しで確かめる、issue #824): 上の cancelled 判定テストはモックが返す行に status を
  //      含めているので、**SELECT から status が落ちても緑のまま**通る（実装中に実際に起きた: 型と
  //      map だけ足されて SELECT が据え置かれ、cancelled が常に false になっていた）。
  //      実 DB の統合テストなら落ちるが、そこまで行かずにここで落とせるように、問い合わせる列そのものを見る。
  //      これが「取る列」の唯一の対照表になるので、載せる列・載せない列を両方向で書く
  it('症例発注の SELECT は患者 ID・イニシャルと取り消し判定用の status を親から取り、医師名・性別・術式名は問い合わせない', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    const select = String(queries.case_order_items.select.mock.calls[0]?.[0])
    expect(select).toContain('patient_id')
    expect(select).toContain('patient_initials')
    expect(select).toContain('status')
    expect(select).not.toContain('doctor_name')
    expect(select).not.toContain('gender')
    expect(select).not.toContain('procedure_name')
    expect(select).not.toContain('*')
  })

  it('短貸返却の行は患者のキーを持たず、取り消しの状態を持つ（キーは決めた集合と完全一致）', async () => {
    const { db } = makeMockDb({
      case_order_items: { data: [], error: null },
      loan_return_items: {
        data: [
          {
            id: 'lri-1', loan_return_id: 'lr-1', jan: '222', lot: 'LOT-A', quantity: 1, status: 'active',
            loan_returns: { facility_id: 'f-1', return_datetime: '2026-09-05T00:00:00Z', status: 'returned' },
          },
        ],
        error: null,
      },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(Object.keys(result.items[0]).sort()).toEqual(
      ['kind', 'itemId', 'parentId', 'lot', 'jan', 'quantity', 'occurredAt', 'cancelled'].sort()
    )
    expect(result.items[0]).toMatchObject({ kind: 'loan_return', cancelled: false })
  })

  // WHY(停止②で判明): 取り消しは「その返却の記録は誤りだった」＝**実際には返していないかもしれない**。
  //      区別なく「返した物」として出すと、リコールの担当者は「返却済み」と読み、院内に残っているロットを取りこぼす。
  //      消さずに出して明示する（消すと「記録はあったが取り消された」が見えなくなる）。
  //      取り消しは 2 段ある: 明細ごと（loan_return_items.status）と、返却の回ごと（loan_returns.status）
  it.each([
    ['明細が取り消し済み', 'cancelled', 'returned', true],
    ['返却の回ごと取り消し済み（明細は active のまま）', 'active', 'cancelled', true],
    ['どちらも生きている', 'active', 'returned', false],
  ])('短貸返却の取り消しを落とさずに出して印を付ける: %s', async (_name, itemStatus, parentStatus, expected) => {
    const { db } = makeMockDb({
      case_order_items: { data: [], error: null },
      loan_return_items: {
        data: [
          {
            id: 'lri-1', loan_return_id: 'lr-1', jan: '222', lot: 'LOT-A', quantity: 1, status: itemStatus,
            loan_returns: { facility_id: 'f-1', return_datetime: '2026-09-05T00:00:00Z', status: parentStatus },
          },
        ],
        error: null,
      },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ kind: 'loan_return', cancelled: expected })
  })

  it('短貸返却の SELECT は明細と親の両方の status を取る（取り消しの 2 段を見るため）', async () => {
    const { db, queries } = makeMockDb(emptyResults())

    await searchLotItems(db, 'f-1', 'ABC')

    const select = String(queries.loan_return_items.select.mock.calls[0]?.[0])
    expect(select).toMatch(/(^|,\s*)status(,|$)/)
    expect(select).toMatch(/loan_returns!inner\([^)]*status[^)]*\)/)
  })

  it('上限ちょうど（500件）では truncated = false', async () => {
    const rows = Array.from({ length: LOT_SEARCH_LIMIT }, (_, i) => ({
      id: `coi-${i}`, case_order_id: `co-${i}`, jan: '111', lot: 'LOT-A', quantity: 1,
      case_orders: { facility_id: 'f-1', case_datetime: new Date(2026, 0, 1, 0, 0, i).toISOString() },
    }))
    const { db } = makeMockDb({
      case_order_items: { data: rows, error: null },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(LOT_SEARCH_LIMIT)
    expect(result.truncated).toBe(false)
  })

  it('上限+1件では truncated = true になり、LIMIT件に切られる', async () => {
    const rows = Array.from({ length: LOT_SEARCH_LIMIT + 1 }, (_, i) => ({
      id: `coi-${i}`, case_order_id: `co-${i}`, jan: '111', lot: 'LOT-A', quantity: 1,
      case_orders: { facility_id: 'f-1', case_datetime: new Date(2026, 0, 1, 0, 0, i).toISOString() },
    }))
    const { db } = makeMockDb({
      case_order_items: { data: rows, error: null },
      loan_return_items: { data: [], error: null },
    })

    const result = await searchLotItems(db, 'f-1', 'LOT-A')

    expect(result.items).toHaveLength(LOT_SEARCH_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('DBエラー時は例外を投げる', async () => {
    const { db } = makeMockDb({
      case_order_items: { data: null, error: { message: 'boom' } },
      loan_return_items: { data: [], error: null },
    })

    await expect(searchLotItems(db, 'f-1', 'LOT-A')).rejects.toThrow('boom')
  })
})
