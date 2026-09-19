import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber } from '@/lib/mapping'
import { buildIlikeValueUnquoted } from '@/lib/search/like-pattern'
import type { LotSearchResultItem } from '@/types/order'
import limitsConfig from '../../../aidd.config.json'

// WHY(決定4・SPEC Part1): 既存の横断検索（KIND_LIMIT）と同じ500件に揃える。
//      `src/lib/validation/text-limits.ts`（limits.textLength）と同じ前例に揃え、
//      aidd.config.json の limits.lotSearchLimit を唯一の出どころにする（人が決めた値を
//      ファイル内に直書きすると、SPEC・設定・コードの3か所に同じ数字が散る）。
//      上限に達したことを画面へ伝えるため、常に LIMIT+1 件を取得し、
//      実際に返すのは LIMIT 件まで（決定5: truncated フラグで超過を知らせる）。
export const LOT_SEARCH_LIMIT: number = limitsConfig.limits.lotSearchLimit

// WHY(SPEC Part2 層2「repository の明示条件」): 明細の表に facility_id 列は無い。
//      親テーブル（case_orders / loan_returns）を !inner で結合し、
//      facility_id を明示的な条件として入れる。RLS（層1）は admin を全施設ぶん通すため、
//      RLS だけに頼るとadminの検索結果が全施設になってしまう。ここは admin かどうかに関わらず
//      常に効く JS 側の絞り込み。
interface CaseOrderItemRow {
  id?: unknown
  case_order_id?: unknown
  jan?: unknown
  lot?: unknown
  quantity?: unknown
  case_orders?: { case_datetime?: unknown } | { case_datetime?: unknown }[] | null
}

interface LoanReturnItemRow {
  id?: unknown
  loan_return_id?: unknown
  jan?: unknown
  lot?: unknown
  quantity?: unknown
  loan_returns?: { return_datetime?: unknown } | { return_datetime?: unknown }[] | null
}

// WHY: PostgRESTの多対1埋め込みは通常オブジェクト単体を返すが、クライアントの
//      バージョン・スキーマキャッシュの状態によって配列で返るケースがあるため両対応する
//      （src/lib/compatibilities/repository.ts の firstOf と同じ理由）。
function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

// WHY(SPEC Part2 層3「患者情報を型とSELECT列の両方で持たない」): ここで組み立てる
//      LotSearchResultItem には患者のフィールドが型として存在しない（コンパイル時に防ぐ）。
//      加えて SELECT でも case_orders から取るのは facility_id（絞り込み専用・戻り値には含めない）
//      と case_datetime のみで、patient_id 等は一切問い合わせていない（実行時にも防ぐ）。
function mapCaseOrderItem(row: CaseOrderItemRow): LotSearchResultItem {
  return {
    kind: 'case_order',
    itemId: asString(row.id),
    parentId: asString(row.case_order_id),
    lot: asString(row.lot),
    jan: asString(row.jan),
    quantity: asNumber(row.quantity),
    occurredAt: asString(firstOf(row.case_orders)?.case_datetime),
  }
}

function mapLoanReturnItem(row: LoanReturnItemRow): LotSearchResultItem {
  return {
    kind: 'loan_return',
    itemId: asString(row.id),
    parentId: asString(row.loan_return_id),
    lot: asString(row.lot),
    jan: asString(row.jan),
    quantity: asNumber(row.quantity),
    occurredAt: asString(firstOf(row.loan_returns)?.return_datetime),
  }
}

async function searchCaseOrderItems(
  db: SupabaseClient,
  facilityId: string,
  ilikeValue: string,
  limitPlusOne: number
): Promise<LotSearchResultItem[]> {
  const { data, error } = await db
    .from('case_order_items')
    .select('id, case_order_id, jan, lot, quantity, case_orders!inner(facility_id, case_datetime)')
    .eq('case_orders.facility_id', facilityId)
    // WHY(受け入れ条件「lot が NULL の明細は検索対象にならない」): ILIKE は NULL に対して
    //      UNKNOWN を返すため既に自然に外れるが、意図を明示するため .not(is null) も付ける
    //      （黙って外れる挙動に依存しない）。
    .not('lot', 'is', null)
    .ilike('lot', ilikeValue)
    // WHY(occurredAt=case_datetime で並べる): 最終マージ後の並び替えは occurredAt（この
    //      テーブルでは case_datetime）で行う。ここを created_at など別の列で並べると、
    //      「各テーブル単体で LIMIT+1 件取れば、マージ後の上位 LIMIT+1 件を取りこぼさない」
    //      という truncated 判定の前提が崩れる（テーブル内の並び順と最終的な並び順が
    //      食い違うと、本来上位に入るはずの行が LIMIT+1 件の外に切り落とされうる）。
    .order('case_datetime', { referencedTable: 'case_orders', ascending: false })
    .limit(limitPlusOne)

  if (error) throw new Error(error.message)
  return ((data ?? []) as CaseOrderItemRow[]).map(mapCaseOrderItem)
}

async function searchLoanReturnItems(
  db: SupabaseClient,
  facilityId: string,
  ilikeValue: string,
  limitPlusOne: number
): Promise<LotSearchResultItem[]> {
  const { data, error } = await db
    .from('loan_return_items')
    .select('id, loan_return_id, jan, lot, quantity, loan_returns!inner(facility_id, return_datetime)')
    .eq('loan_returns.facility_id', facilityId)
    .not('lot', 'is', null)
    .ilike('lot', ilikeValue)
    // WHY: 上の case_order_items と同じ理由。occurredAt（この
    //      テーブルでは return_datetime）で並べておかないと、truncated 判定の前提が崩れる。
    .order('return_datetime', { referencedTable: 'loan_returns', ascending: false })
    .limit(limitPlusOne)

  if (error) throw new Error(error.message)
  return ((data ?? []) as LoanReturnItemRow[]).map(mapLoanReturnItem)
}

/**
 * 施設内のロット検索（issue #803 Set A）。
 * `case_order_items`（症例で使った物）と `loan_return_items`（返した物）を横断して、
 * ロット番号が部分一致（中間一致）する明細を occurredAt 降順で返す。
 *
 * WHY(上限+1件取得してtruncatedを決める): 2テーブルそれぞれに LIMIT+1 件まで問い合わせ、
 *      マージ後の件数が LIMIT を超えていたら truncated=true にして LIMIT 件で切る。
 *      各テーブル単体でも LIMIT+1 あれば「マージ後の上位 LIMIT+1 件」を取りこぼさない
 *      （単体リスト内で LIMIT+1 位より後ろの要素は、そのテーブル内だけで既に LIMIT+1 個に
 *      負けているため、2テーブル合算の上位 LIMIT+1 件にも入り得ない）。
 */
export async function searchLotItems(
  db: SupabaseClient,
  facilityId: string,
  lot: string
): Promise<{ items: LotSearchResultItem[]; truncated: boolean }> {
  // WHY: .ilike() に単一カラムを直接渡す場合は buildIlikeValueUnquoted を使う
  //      （buildIlikeValue の引用符囲みは .or() 専用。詳細は like-pattern.ts のコメント参照）
  const ilikeValue = buildIlikeValueUnquoted(lot)
  const limitPlusOne = LOT_SEARCH_LIMIT + 1

  const [caseOrderItems, loanReturnItems] = await Promise.all([
    searchCaseOrderItems(db, facilityId, ilikeValue, limitPlusOne),
    searchLoanReturnItems(db, facilityId, ilikeValue, limitPlusOne),
  ])

  const merged = [...caseOrderItems, ...loanReturnItems].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  )

  const truncated = merged.length > LOT_SEARCH_LIMIT
  return { items: merged.slice(0, LOT_SEARCH_LIMIT), truncated }
}
