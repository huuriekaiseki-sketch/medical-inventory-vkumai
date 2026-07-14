import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import { assertValidListOptions } from '@/lib/orders/list-options-validation'
import type { LoanReturn, LoanReturnInput, LoanReturnItem, OrderListFilterOptions } from '@/types/order'

const STATUSES = ['draft', 'returned'] as const

const LOAN_RETURN_COLUMNS = 'id, facility_id, return_datetime, status, created_at, updated_at'
// 注: updated_at は Group A のマイグレーション適用前のため明細列挙には含めない
const LOAN_RETURN_ITEM_COLUMNS = 'id, loan_return_id, jan, lot, ubd, quantity, created_at'

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
  options?: OrderListFilterOptions
): Promise<LoanReturn[]> {
  assertValidListOptions(limit, offset)
  // issue #20 SET-C: 品名検索（productSearch）は loan_return_items に name 列が無く、
  // jan → products.name の突合が必要。loan_return_items.jan は products.jan への FK では
  // ないため PostgREST の埋め込み(embed) join が使えず、2段階の絞り込みクエリで解決する
  // （① products から該当jan群を取得 → ② loan_return_items からその jan群に紐づく
  // loan_return_id群を取得 → ③ メインクエリに .in('id', ...) で適用）
  const productSearch = options?.productSearch?.trim()
  let loanReturnIds: string[] | undefined
  if (productSearch) {
    const { data: productRows, error: productError } = await db
      .from('products')
      .select('jan')
      .ilike('name', `%${productSearch}%`)
    if (productError) throw new Error(productError.message)
    const jans = ((productRows ?? []) as { jan?: unknown }[]).map(p => asString(p.jan))
    if (jans.length === 0) return []

    const { data: itemRows, error: itemError } = await db
      .from('loan_return_items')
      .select('loan_return_id')
      .in('jan', jans)
    if (itemError) throw new Error(itemError.message)
    loanReturnIds = Array.from(
      new Set(((itemRows ?? []) as { loan_return_id?: unknown }[]).map(r => asString(r.loan_return_id)))
    )
    if (loanReturnIds.length === 0) return []
  }

  let query = db
    .from('loan_returns')
    .select(`${LOAN_RETURN_COLUMNS}, loan_return_items(${LOAN_RETURN_ITEM_COLUMNS})`)
    .eq('facility_id', facilityId)
  if (options?.dateFrom) query = query.gte('return_datetime', options.dateFrom)
  if (options?.dateTo) query = query.lte('return_datetime', options.dateTo)
  if (loanReturnIds) query = query.in('id', loanReturnIds)

  // issue #20 型安全・データ層整合レビュー対応（critical）: dateFrom/dateTo は return_datetime で
  // 絞り込んでいるため、.order() も created_at ではなく return_datetime にしないと、
  // 施設ごとの該当件数が limit を超えた場合に DB 側で誤った基準（created_at）で先に
  // 切り詰められ、unified-repository.ts の fetchTopN が前提とする
  // 「displayDatetime(=return_datetime)降順で上位N件」という不変条件が壊れる。
  // id を第2キーにして同時刻のページング順序も安定させる
  //
  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel（SET-D）は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(loan_return_items(...))に明示的な
  // ORDER BY を指定しないと代表製品名の選出が理論上非決定的になる。作成順
  // （created_at昇順・id昇順を第2キー）を明示し、「最初に登録した明細」を安定して
  // 代表として選出する
  const { data, error } = await query
    .order('return_datetime', { ascending: false })
    .order('id', { ascending: true })
    .order('created_at', { ascending: true, referencedTable: 'loan_return_items' })
    .order('id', { ascending: true, referencedTable: 'loan_return_items' })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (LoanReturnRow & { loan_return_items?: LoanReturnItemRow[] })[]).map(r => ({
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: (r.loan_return_items ?? []).map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
  }))
}

export async function createLoanReturn(db: SupabaseClient, facilityId: string, input: LoanReturnInput): Promise<LoanReturn> {
  const { data: ret, error: retError } = await db
    .from('loan_returns')
    .insert({ facility_id: facilityId, return_datetime: input.returnDatetime })
    .select(LOAN_RETURN_COLUMNS)
    .single()
  if (retError) throw new Error(retError.message)
  if (!ret) throw new Error('loan_returns の作成に失敗しました')

  const r = ret as LoanReturnRow
  const itemRows = input.items.map(item => ({
    loan_return_id: r.id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await db
    .from('loan_return_items')
    .insert(itemRows)
    .select(LOAN_RETURN_ITEM_COLUMNS)
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: (items as LoanReturnItemRow[]).map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
  }
}
