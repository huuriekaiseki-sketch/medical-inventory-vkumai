import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { toRepositoryError } from '@/lib/invariant-error'
import type { LoanReturn, LoanReturnInput, LoanReturnItem } from '@/types/order'

const STATUSES = ['draft', 'returned', 'cancelled'] as const

/** 取り消そうとした返却が見つからない（他施設のものを含む）。route が 404 に写す */
export const LOAN_RETURN_NOT_FOUND_ERROR = '返却が見つかりません'
/** すでに取り消し済み。route が 409 に写す */
export const LOAN_RETURN_ALREADY_CANCELLED_ERROR = 'この返却はすでに取り消されています'

// loan_order_id: issue #20 (Set A) で追加した loan_orders への FK。既存行は NULL のまま
const LOAN_RETURN_COLUMNS = 'id, facility_id, return_datetime, status, created_at, updated_at, loan_order_id'
// 注: updated_at は Group A のマイグレーション適用前のため明細列挙には含めない
const LOAN_RETURN_ITEM_COLUMNS = 'id, loan_return_id, jan, lot, ubd, quantity, created_at, loan_order_item_id'

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
  loan_order_item_id?: unknown
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
    loanOrderItemId: asOptionalString(row.loan_order_item_id),
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
    p_header: {
      facility_id: facilityId,
      return_datetime: input.returnDatetime,
      loan_order_id: loanOrderId ?? null,
      // WHY: 返却 RPC はシグネチャを変えず p_header の中で鍵を受ける（P-053）。無ければ入れない
      ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
    },
    p_items: input.items.map(item => ({
      jan: item.jan,
      lot: item.lot ?? null,
      ubd: item.ubd ?? null,
      quantity: item.quantity,
      // WHY: どの発注明細に対する返却か（20260908030000）。分割返却の残数と過剰返却の判定に使う。
      //      施設・発注をまたいだ紐付けは RPC が弾く（20260908040000）
      loan_order_item_id: item.loanOrderItemId ?? null,
    })),
  })
  if (error) {
    // WHY(23505): 2026-09-08 に loan_order_id の部分 UNIQUE は外した（分割返却を許すため、
    //      20260908030000）。ここへ来る 23505 は client_request_id の索引だけで、RPC が
    //      再送として処理しきれなかった場合に限る。生の Postgres エラーは制約名・表名を含むので
    //      そのまま投げない
    if (error.code === '23505') throw new ClientVisibleError('同じ内容の返却が既に登録されています')
    // WHY(23514): 借りた数を超える返却をトリガーが拒否する（I-030）。
    //      toRepositoryError の一般的な文言では「数量が多すぎる」ことが伝わらないので個別に写す
    if (error.code === '23514' && /exceeds ordered quantity/.test(error.message ?? '')) {
      throw new ClientVisibleError('返却の数量が、借りた数量を超えています')
    }
    // WHY(23503): 他施設・他発注の明細へ紐付けようとした（RPC が foreign_key_violation で上げる）
    if (error.code === '23503' && /loan order item/.test(error.message ?? '')) {
      throw new ClientVisibleError('返却対象の明細が、選んだ短貸発注のものではありません')
    }
    throw toRepositoryError(error)
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

/**
 * 返却を取り消す（E-056。行は消さず `cancelled` にする）。
 *
 * WHY(削除しない): 誰がいつ何を取り消したかを残す。行を消すと業務の一覧から消えてしまい、
 *      「間違えた返却があった」こと自体が追えなくなる。status の変更は監査トリガーが残す。
 *
 * WHY(施設を明示的に条件へ入れる): RLS だけに頼らず、`facility_id` を条件に入れて
 *      「存在するが他施設のもの」を確実に弾く（`createLoanReturn` の紐付け検証と同じ多層防御）。
 *      RLS は拒否ではなく 0 行にするので、0 行を 404 に写す。
 *
 * WHY(すでに取り消し済みを分ける): DB のトリガーは「取り消しからは戻れない」だけを守る。
 *      同じ返却を 2 回取り消しても実害は無いが、利用者には「もう取り消してあります」と
 *      伝えたほうが親切で、二重送信と区別できる。
 */
export async function cancelLoanReturn(
  db: SupabaseClient,
  facilityId: string,
  id: string
): Promise<LoanReturn> {
  const { data: current, error: readError } = await db
    .from('loan_returns')
    .select(LOAN_RETURN_COLUMNS)
    .eq('id', id)
    .eq('facility_id', facilityId)
    .maybeSingle()
  if (readError) throw toRepositoryError(readError)
  if (!current) throw new ClientVisibleError(LOAN_RETURN_NOT_FOUND_ERROR)
  if ((current as LoanReturnRow).status === 'cancelled') {
    throw new ClientVisibleError(LOAN_RETURN_ALREADY_CANCELLED_ERROR)
  }

  const { data, error } = await db
    .from('loan_returns')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('facility_id', facilityId)
    .select(LOAN_RETURN_COLUMNS)
    .maybeSingle()
  if (error) throw toRepositoryError(error)
  // RLS で 0 行になった場合（読めるが書けない立場＝viewer）
  if (!data) throw new ClientVisibleError('返却を取り消す権限がありません')

  const r = data as LoanReturnRow
  return {
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: [],
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
    loanOrderId: asOptionalString(r.loan_order_id),
  }
}
