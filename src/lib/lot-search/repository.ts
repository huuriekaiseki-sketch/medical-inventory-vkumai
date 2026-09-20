import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber } from '@/lib/mapping'
import { buildIlikeValueUnquoted } from '@/lib/search/like-pattern'
import type { LotSearchCaseOrderItem, LotSearchLoanReturnItem, LotSearchResultItem } from '@/types/order'
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
interface CaseOrderParentRow {
  case_datetime?: unknown
  patient_id?: unknown
  patient_initials?: unknown
  /** 症例発注の取り消し状態（issue #824）。親 `case_orders.status` を PostgREST の埋め込みで取る */
  status?: unknown
}

interface CaseOrderItemRow {
  id?: unknown
  case_order_id?: unknown
  jan?: unknown
  lot?: unknown
  quantity?: unknown
  case_orders?: CaseOrderParentRow | CaseOrderParentRow[] | null
}

interface LoanReturnParentRow {
  return_datetime?: unknown
  status?: unknown
}

interface LoanReturnItemRow {
  id?: unknown
  loan_return_id?: unknown
  jan?: unknown
  lot?: unknown
  quantity?: unknown
  status?: unknown
  loan_returns?: LoanReturnParentRow | LoanReturnParentRow[] | null
}

// WHY: PostgRESTの多対1埋め込みは通常オブジェクト単体を返すが、クライアントの
//      バージョン・スキーマキャッシュの状態によって配列で返るケースがあるため両対応する
//      （src/lib/compatibilities/repository.ts の firstOf と同じ理由）。
function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

// WHY(決定 6 = (b)。2026-09-19 に決め直した。issue #824 で status を追加): 症例発注の行には、リコールで
//      「どの患者に使ったか」を特定するための**患者 ID とイニシャル**、加えて取り消し判定用の **status** だけを
//      載せる。status は個人情報ではなく取り消し済みか（case_orders.status === 'cancelled'）を判定するためだけに使う。
//      医師名・性別・術式名は引き続き載せない。守り方は 2 段のまま:
//      型に無い（LotSearchCaseOrderItem。コンパイル時）／SELECT で問い合わせない（実行時）。
//      **フィールドを 1 つずつ写す**（`...parent` のように広げない）ので、仮に列が余分に返ってきても戻り値には入らない
//
// WHY(1 段だけで判定する): 症例発注の取り消しは親の status だけ。`case_order_items` に status 列は無いので、
//      下の mapLoanReturnItem のような 2 段の OR を書き写すと、存在しない列を読んで常に false 側へ倒れる
function mapCaseOrderItem(row: CaseOrderItemRow): LotSearchCaseOrderItem {
  const parent = firstOf(row.case_orders)
  return {
    kind: 'case_order',
    itemId: asString(row.id),
    parentId: asString(row.case_order_id),
    lot: asString(row.lot),
    jan: asString(row.jan),
    quantity: asNumber(row.quantity),
    occurredAt: asString(parent?.case_datetime),
    patientId: asString(parent?.patient_id),
    patientInitials: asString(parent?.patient_initials),
    cancelled: asString(parent?.status) === 'cancelled',
  }
}

// WHY(cancelled): 取り消しは「その返却の記録は誤りだった」＝実際には返していないかもしれない。
//      区別なく「返した物」と出すと、リコールの担当者は返却済みと読んで、院内に残ったロットを取りこぼす。
//      検索結果から**落とさず**に印を付ける（落とすと「記録はあったが取り消された」が見えなくなる）。
//      取り消しは 2 段: 明細ごと（20260909000000）と、返却の回ごと（20260908060000）。どちらでも true
function mapLoanReturnItem(row: LoanReturnItemRow): LotSearchLoanReturnItem {
  const parent = firstOf(row.loan_returns)
  return {
    kind: 'loan_return',
    itemId: asString(row.id),
    parentId: asString(row.loan_return_id),
    lot: asString(row.lot),
    jan: asString(row.jan),
    quantity: asNumber(row.quantity),
    occurredAt: asString(parent?.return_datetime),
    cancelled: asString(row.status) === 'cancelled' || asString(parent?.status) === 'cancelled',
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
    // WHY(列を名指しする。`*` にしない): 親から取るのは絞り込み用の facility_id・並び用の case_datetime・
    //      特定用の patient_id / patient_initials・取り消し判定用の status だけ。医師名・性別・術式名は問い合わせない
    .select(
      'id, case_order_id, jan, lot, quantity, case_orders!inner(facility_id, case_datetime, patient_id, patient_initials, status)'
    )
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
    // WHY(status を 2 つ取る): 取り消しは明細ごとと返却の回ごとの 2 段。片方だけ見ると、回ごと取り消した返却の明細
    //      （明細の status は active のまま）を「返した物」と出してしまう。**絞り込みには使わない**（落とさず印を付ける）
    .select('id, loan_return_id, jan, lot, quantity, status, loan_returns!inner(facility_id, return_datetime, status)')
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
