import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import { ClientVisibleError } from '@/lib/client-visible-error'
import type { LoanReturn, LoanReturnInput, LoanReturnItem } from '@/types/order'

const STATUSES = ['draft', 'returned'] as const

// loan_order_id: issue #20 (Set A) で追加した loan_orders への FK。既存行は NULL のまま
const LOAN_RETURN_COLUMNS = 'id, facility_id, return_datetime, status, created_at, updated_at, loan_order_id'
// 注: updated_at は Group A のマイグレーション適用前のため明細列挙には含めない
const LOAN_RETURN_ITEM_COLUMNS = 'id, loan_return_id, jan, lot, ubd, quantity, created_at'

// WHY: 重複定義していたフィルタ型を src/lib/orders/list-filter.ts に統合（issue #20 レビュー指摘）
export type LoanReturnListFilter = OrderRepositoryFilter

// WHY: createLoanReturn に loanOrderId を渡した際、facilityIdの検証なしに紐付けると
//      他施設のloan_orders.idを指定してテナント境界を越えたデータ汚染が起こり得る
//      （issue #20 レビュー指摘: critical）。呼び出し元（route.ts）がこのメッセージで
//      400を判別できるよう固定文言のエラーとして投げる
export const LOAN_ORDER_NOT_FOUND_ERROR = '指定された短貸発注が見つかりません'

interface LoanReturnItemRow {
  id?: unknown
  loan_return_id?: unknown
  jan?: unknown
  lot?: unknown
  ubd?: unknown
  quantity?: unknown
  created_at?: unknown
}

interface LoanReturnRow {
  id?: unknown
  facility_id?: unknown
  return_datetime?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
  loan_order_id?: unknown
}

export function mapItem(row: LoanReturnItemRow): LoanReturnItem {
  return {
    id: asString(row.id),
    loanReturnId: asString(row.loan_return_id),
    jan: asString(row.jan),
    lot: asOptionalString(row.lot),
    ubd: asOptionalString(row.ubd),
    quantity: asNumber(row.quantity),
    createdAt: asString(row.created_at),
  }
}

export async function listLoanReturns(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  filter?: LoanReturnListFilter
): Promise<LoanReturn[]> {
  let query = db
    .from('loan_returns')
    .select(`${LOAN_RETURN_COLUMNS}, loan_return_items(${LOAN_RETURN_ITEM_COLUMNS})`)
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter?.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter?.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))

  // WHY: loan_returns にはキーワード対象になるヘッダー列がなく、items[].janのみが対象。
  //      keyword指定時はDB側でrangeせず取得してからJS側で一致判定し、
  //      その後にoffset/limitを適用する（filter未指定時は従来通りDB側でrangeする）。
  //      無制限取得はDoSベクタになるため created_at 降順 KEYWORD_SCAN_LIMIT 件で打ち切る
  //      （issue #20 レビュー指摘: 正しさ important）
  if (filter?.keyword) query = query.limit(KEYWORD_SCAN_LIMIT)
  else query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  let rows = (data ?? []) as (LoanReturnRow & { loan_return_items?: LoanReturnItemRow[] })[]

  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase()
    rows = rows.filter(r => (r.loan_return_items ?? []).some(i => asString(i.jan).toLowerCase().includes(kw)))
    rows = rows.slice(offset, offset + limit)
  }

  return rows.map(r => ({
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: (r.loan_return_items ?? []).map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
    loanOrderId: asOptionalString(r.loan_order_id),
  }))
}

// WHY: 「未返却」判定（issue #20）は loan_orders 側から loan_returns.loan_order_id への
//      逆方向JOINで対応返却の有無を見る。作成経路で loan_order_id を渡さない限り
//      新規の返却も永久に未返却扱いのままになってしまうため、任意の第4引数として
//      呼び出し元（UI）から紐付け対象の loan_order id を受け取れるようにする。
//      LoanReturnInput型自体は変更しない（契約は型定義側の管理のため、別パラメータとして追加する）
export async function createLoanReturn(db: SupabaseClient, facilityId: string, input: LoanReturnInput, loanOrderId?: string): Promise<LoanReturn> {
  // WHY: loanOrderId はクライアントから渡される値をそのまま信用してINSERTすると、
  //      他施設のloan_orders.idを指定してテナント境界を越えて紐付けられてしまう
  //      （issue #20 レビュー指摘: critical）。insert前に「facilityIdに属するloan_orderか」を
  //      明示的に検証する（RLSがある場合でも、facility_idを条件に含めることで
  //      「存在するが他施設のもの」を確実に弾く多層防御にする）
  if (loanOrderId) {
    const { data: loanOrder, error: loanOrderError } = await db
      .from('loan_orders')
      .select('id')
      .eq('id', loanOrderId)
      .eq('facility_id', facilityId)
      .maybeSingle()
    if (loanOrderError) throw new Error(loanOrderError.message)
    if (!loanOrder) throw new ClientVisibleError(LOAN_ORDER_NOT_FOUND_ERROR)
  }

  // WHY: header/itemsを別々にINSERTすると、items失敗時にheaderだけが孤児レコードとして
  //      残るリスクがある(architecture review 2026-07-26 issue #2)。既存のatomic RPC
  //      (supabase/migrations/20260629000002_loan_return_atomic_rpc.sql)で単一トランザクションに
  //      統一する。loanOrderIdのテナント境界検証は上記で完了済みのため、RPC側では再検証しない
  const { data, error } = await db.rpc('create_loan_return_atomic', {
    p_header: { facility_id: facilityId, return_datetime: input.returnDatetime, loan_order_id: loanOrderId ?? null },
    p_items: input.items.map(item => ({
      jan: item.jan,
      lot: item.lot ?? null,
      ubd: item.ubd ?? null,
      quantity: item.quantity,
    })),
  })
  if (error) {
    // WHY: loan_returns.loan_order_id には部分UNIQUEインデックス(loan_order_id IS NOT NULL)
    //      が追加されている(issue #675 セットA)。同一loan_order_idへの2回目の返却登録は
    //      Postgresの一意制約違反(23505)になる。生のPostgresエラー(制約名・テーブル名を
    //      含む文字列)をそのままthrowするとスキーマ情報が漏洩しうるため、ClientVisibleError
    //      として翻訳しroute側で400として扱えるようにする(consumables/repository.ts:53と同じパターン)
    if (error.code === '23505') throw new ClientVisibleError('この短貸発注は既に返却登録されています')
    throw new Error(error.message)
  }
  if (!data) throw new ClientVisibleError('loan_returns の作成に失敗しました')

  const r = data as LoanReturnRow & { items?: unknown }
  const itemRows = Array.isArray(r.items) ? (r.items as LoanReturnItemRow[]) : []

  return {
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: itemRows.map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
    loanOrderId: asOptionalString(r.loan_order_id),
  }
}
