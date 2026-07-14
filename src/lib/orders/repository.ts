import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import type { OrderListItem, OrderListFilter, OrderKind } from '@/types/order'

// WHY(重複実装について・issue #20 レビュー指摘: 型安全・データ層の整合 important):
//   listCaseOrders/listConsumableOrders/listLoanOrders/listLoanReturns と本ファイルの
//   fetchXxxItems は keyword/dateFrom/dateTo の絞り込みロジック自体は類似しているが、
//   意図的に別クエリとして実装している（SPEC.md Part2 Set C参照）。理由:
//   1) unreturned 判定には loan_orders への `loan_returns!left(id)` 逆方向JOINが必要で、
//      施設別ページ用の listLoanOrders には無い専用クエリ
//   2) summary生成（consumable_orderの消耗品名連結など）は横断一覧固有の表示要件で、
//      施設別ページ用の戻り値型（LoanOrder等）には持たせられない
//   3) 各テーブルを個別にLIMIT付きで取得しメモリ内マージソートする方式自体が
//      横断一覧固有の設計（Set Cのoffset/limit戦略）
//   したがって完全な共通化はせず、日付境界変換（jstDayStart/jstDayEnd）と
//   フィルタ型（OrderRepositoryFilter, src/lib/orders/list-filter.ts）、
//   keyword無制限クエリ防止の上限値（KEYWORD_SCAN_LIMIT）のみを共有し、
//   キーワード一致判定ロジック自体の重複リスクは許容する（乖離した場合はテストで検知する）

// WHY: 性能上の上限（v1スコープ）。各テーブルへのクエリは常に created_at 降順 LIMIT 500 を
//      付与してから取得する（4テーブル合計で最大2000行）。全件取得はしない。
//      施設単位の発注件数がこれを大きく超える運用が確認された場合は、cursor-based
//      pagination か UNION ビューへの置き換えを別issueで検討する（本issueのスコープ外）
const KIND_LIMIT = 500

const ALL_KINDS: OrderKind[] = ['case_order', 'consumable_order', 'loan_order', 'loan_return']

interface CaseOrderRow {
  id?: unknown
  facility_id?: unknown
  procedure_name?: unknown
  status?: unknown
  created_at?: unknown
  case_order_items?: { jan?: unknown }[]
}

interface ConsumableOrderRow {
  id?: unknown
  facility_id?: unknown
  status?: unknown
  created_at?: unknown
  consumable_order_items?: { consumables?: { name?: unknown; jan?: unknown } | null }[]
}

interface LoanOrderRow {
  id?: unknown
  facility_id?: unknown
  procedure_name?: unknown
  maker?: unknown
  status?: unknown
  created_at?: unknown
  loan_order_items?: { name?: unknown }[]
  loan_returns?: { id?: unknown }[]
}

interface LoanReturnRow {
  id?: unknown
  facility_id?: unknown
  status?: unknown
  return_datetime?: unknown
  created_at?: unknown
  loan_return_items?: { jan?: unknown }[]
}

async function fetchCaseOrderItems(db: SupabaseClient, facilityId: string, filter: OrderListFilter, effectiveLimit: number): Promise<OrderListItem[]> {
  let query = db
    .from('case_orders')
    .select('*, case_order_items(jan)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))
  query = query.limit(effectiveLimit)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  // WHY: keyword は procedure_name と items[].jan の OR一致が要件のため、
  //      DB側のAND条件だけでは表現できない。日付フィルタ後の行を取得してから
  //      JS側でOR一致を判定する
  const kw = filter.keyword?.toLowerCase()
  return ((data ?? []) as CaseOrderRow[])
    .filter(o => {
      if (!kw) return true
      const procedureMatch = asString(o.procedure_name).toLowerCase().includes(kw)
      const itemMatch = (o.case_order_items ?? []).some(i => asString(i.jan).toLowerCase().includes(kw))
      return procedureMatch || itemMatch
    })
    .map(o => ({
      id: asString(o.id),
      kind: 'case_order' as const,
      facilityId: asString(o.facility_id),
      status: asString(o.status),
      summary: asString(o.procedure_name),
      createdAt: asString(o.created_at),
    }))
}

async function fetchConsumableOrderItems(db: SupabaseClient, facilityId: string, filter: OrderListFilter, effectiveLimit: number): Promise<OrderListItem[]> {
  let query = db
    .from('consumable_orders')
    .select('*, consumable_order_items(*, consumables(name, jan))')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))
  query = query.limit(effectiveLimit)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const kw = filter.keyword?.toLowerCase()
  return ((data ?? []) as ConsumableOrderRow[])
    .filter(o => {
      if (!kw) return true
      return (o.consumable_order_items ?? []).some(item => {
        const name = asString(item.consumables?.name).toLowerCase()
        const jan = asString(item.consumables?.jan).toLowerCase()
        return name.includes(kw) || jan.includes(kw)
      })
    })
    .map(o => {
      const items = o.consumable_order_items ?? []
      const names = items
        .map(item => asOptionalString(item.consumables?.name))
        .filter((n): n is string => Boolean(n))
      // WHY: 1件も消耗品名が取れない場合のみ品目数フォールバック（SPEC Set C）
      const summary = names.length > 0 ? names.join('、') : `消耗品 ${items.length} 品目`
      return {
        id: asString(o.id),
        kind: 'consumable_order' as const,
        facilityId: asString(o.facility_id),
        status: asString(o.status),
        summary,
        createdAt: asString(o.created_at),
      }
    })
}

async function fetchLoanOrderItems(db: SupabaseClient, facilityId: string, filter: OrderListFilter, effectiveLimit: number): Promise<OrderListItem[]> {
  // WHY: 「未返却」判定のため loan_returns を LEFT JOIN で埋め込み取得する
  //      （loan_returns.loan_order_id -> loan_orders.id の逆方向embed）
  let query = db
    .from('loan_orders')
    .select('*, loan_order_items(name), loan_returns!left(id)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))
  query = query.limit(effectiveLimit)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const kw = filter.keyword?.toLowerCase()
  return ((data ?? []) as LoanOrderRow[])
    .filter(o => {
      if (!kw) return true
      const procedureMatch = asString(o.procedure_name).toLowerCase().includes(kw)
      const makerMatch = asString(o.maker).toLowerCase().includes(kw)
      const itemMatch = (o.loan_order_items ?? []).some(i => asString(i.name).toLowerCase().includes(kw))
      return procedureMatch || makerMatch || itemMatch
    })
    .map(o => {
      const status = asString(o.status)
      const returns = o.loan_returns ?? []
      const unreturned = status === 'submitted' && returns.length === 0
      return {
        id: asString(o.id),
        kind: 'loan_order' as const,
        facilityId: asString(o.facility_id),
        status,
        summary: `${asString(o.procedure_name)}（${asString(o.maker)}）`,
        createdAt: asString(o.created_at),
        unreturned,
      }
    })
}

async function fetchLoanReturnItems(db: SupabaseClient, facilityId: string, filter: OrderListFilter, effectiveLimit: number): Promise<OrderListItem[]> {
  let query = db
    .from('loan_returns')
    .select('*, loan_return_items(jan)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))
  query = query.limit(effectiveLimit)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const kw = filter.keyword?.toLowerCase()
  return ((data ?? []) as LoanReturnRow[])
    .filter(r => {
      if (!kw) return true
      return (r.loan_return_items ?? []).some(i => asString(i.jan).toLowerCase().includes(kw))
    })
    .map(r => ({
      id: asString(r.id),
      kind: 'loan_return' as const,
      facilityId: asString(r.facility_id),
      status: asString(r.status),
      summary: `返却 ${new Date(asString(r.return_datetime)).toLocaleDateString('ja-JP')}`,
      createdAt: asString(r.created_at),
    }))
}

const FETCHERS: Record<OrderKind, (db: SupabaseClient, facilityId: string, filter: OrderListFilter, effectiveLimit: number) => Promise<OrderListItem[]>> = {
  case_order: fetchCaseOrderItems,
  consumable_order: fetchConsumableOrderItems,
  loan_order: fetchLoanOrderItems,
  loan_return: fetchLoanReturnItems,
}

/**
 * 施設内の4種別発注（症例発注・消耗品発注・短貸発注・短貸返却）を横断して取得する。
 * 各テーブルへは createdAt 降順 LIMIT で個別にクエリし、メモリ内でマージソートしてから
 * offset/limit を適用する（issue #20 発注履歴ページ）。
 *
 * WHY: 各テーブルのLIMITを固定500のままにすると、kind指定時（クエリ対象が1テーブルのみ）に
 *      offset+limitが500を超えるページ要求で必要な行がそもそもDBから取得されず、
 *      ページングが早期に破綻する（レビュー指摘: 境界条件バグ）。
 *      K個のソート済みリストをマージした際の上位N件は、各リスト単体の上位N件に必ず含まれる
 *      （あるリスト内で順位がNを超える要素は、そのリスト内だけで既にN個の要素に負けているため
 *      全体でも上位N件には入り得ない）。したがって各テーブルのLIMITは
 *      max(KIND_LIMIT, offset + limit) 件あれば offset..offset+limit のスライスに十分足りる。
 */
export async function listOrders(
  db: SupabaseClient,
  facilityId: string,
  filter: OrderListFilter,
  limit = 50,
  offset = 0
): Promise<OrderListItem[]> {
  const kinds: OrderKind[] = filter.kind ? [filter.kind] : ALL_KINDS
  const effectiveLimit = Math.max(KIND_LIMIT, offset + limit)

  const results = await Promise.all(kinds.map(kind => FETCHERS[kind](db, facilityId, filter, effectiveLimit)))
  const merged = results.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return merged.slice(offset, offset + limit)
}
