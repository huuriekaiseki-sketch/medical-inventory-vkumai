import type { SupabaseClient } from '@supabase/supabase-js'
import { listCaseOrders } from '@/lib/case-orders/repository'
import { listConsumableOrders } from '@/lib/consumable-orders/repository'
import { listLoanOrders } from '@/lib/loan-orders/repository'
import { listLoanReturns } from '@/lib/loan-returns/repository'
import { listFacilities } from '@/lib/facilities/repository'
import { asString } from '@/lib/mapping'
import type {
  CaseOrder,
  ConsumableOrder,
  LoanOrder,
  LoanReturn,
  OrderKind,
  OrderListFilterOptions,
  OrdersFetchError,
  OrdersFilter,
  OrdersGetResponse,
  UnifiedOrder,
} from '@/types/order'

const ALL_KINDS: OrderKind[] = ['case', 'consumable', 'loan', 'loan_return']
// SPEC.md Part2 SET-D: 「各種別limit=20固定、v1ではoffset無し」
const LIMIT_PER_KIND = 20

// WHY(issue #20 SET-D): /api/orders route.ts から呼ばれる集約関数。SET-Cの4つの list*
// リポジトリ関数を Promise.allSettled で並列取得し、summaryLabel解決（jan→products.name /
// consumable_id→consumables.name のバッチIN句、N+1回避）を経て
// displayDatetime降順・同時刻id昇順で安定ソートした結果を返す。
// route.tsを薄く保ち、将来の種別追加をこのファイル1箇所に閉じ込める設計とする（SPEC.md記載通り）。
//
// 注: SET-C の list*() は facilityId を必須の単一文字列でしか受け取らない設計のため、
// admin が施設フィルタ未選択（filter.facilityId === undefined、全施設対象）の場合は
// 全施設分をここでループして種別ごとにマージ→上位20件へ絞り込む（SET-C側の実装は変更しない）。
export async function fetchUnifiedOrders(db: SupabaseClient, filter: OrdersFilter): Promise<OrdersGetResponse> {
  // WHY: orderKindsが「未指定(undefined)」の場合のみ「全種別対象」にフォールバックする。
  // 呼び出し元（route.ts）は種別チェックボックスを全て外した明示的な選択を空配列として渡すため、
  // ここで空配列をALL_KINDSにフォールバックさせると「0件選択」というUI状態と「全種別のデータが
  // 返る」という実データが矛盾してしまう（issue #20 レビュー指摘: 境界条件バグ）。
  const kinds = new Set<OrderKind>(filter.orderKinds ?? ALL_KINDS)
  const options: OrderListFilterOptions = {
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    productSearch: filter.productSearch,
  }

  // facilities は authenticated であれば全件SELECT可能な共有マスタ（auth_onlyポリシー）。
  // facilityName表示（admin向け）と、admin全施設対象時の対象facilityId解決の両方に使う
  const facilities = await listFacilities(db)
  const facilityNameById = new Map(facilities.map(f => [f.id, f.name]))
  const targetFacilityIds = filter.facilityId ? [filter.facilityId] : facilities.map(f => f.id)

  const [caseResult, consumableResult, loanResult, loanReturnResult] = await Promise.allSettled([
    kinds.has('case')
      ? fetchTopN(db, listCaseOrders, targetFacilityIds, options, o => o.caseDatetime)
      : Promise.resolve<CaseOrder[]>([]),
    kinds.has('consumable')
      ? fetchTopN(db, listConsumableOrders, targetFacilityIds, options, o => o.createdAt)
      : Promise.resolve<ConsumableOrder[]>([]),
    kinds.has('loan')
      ? fetchTopN(db, listLoanOrders, targetFacilityIds, options, o => o.createdAt)
      : Promise.resolve<LoanOrder[]>([]),
    kinds.has('loan_return')
      ? fetchTopN(db, listLoanReturns, targetFacilityIds, options, o => o.returnDatetime)
      : Promise.resolve<LoanReturn[]>([]),
  ])

  const errors: OrdersFetchError[] = []
  const caseOrders = unwrap(caseResult, 'case', errors)
  const consumableOrders = unwrap(consumableResult, 'consumable', errors)
  const loanOrders = unwrap(loanResult, 'loan', errors)
  const loanReturns = unwrap(loanReturnResult, 'loan_return', errors)

  // summaryLabelの解決: jan経路(case_orders・loan_returns)とconsumable_id経路(consumable_orders)を
  // それぞれバッチ化してIN句1本で解決する（N+1回避。loan_ordersはloan_order_items.nameを
  // 直接使うためJOIN/IN句不要。SPEC.md Part2 SET-D記載通り）
  const jans = Array.from(
    new Set(
      [...caseOrders.map(o => o.items[0]?.jan), ...loanReturns.map(o => o.items[0]?.jan)].filter(
        (v): v is string => !!v
      )
    )
  )
  const consumableIds = Array.from(
    new Set(consumableOrders.map(o => o.items[0]?.consumableId).filter((v): v is string => !!v))
  )

  const [productNameByJan, consumableNameById] = await Promise.all([
    fetchNamesByKey(db, 'products', 'jan', jans),
    fetchNamesByKey(db, 'consumables', 'id', consumableIds),
  ])

  const orders: UnifiedOrder[] = [
    ...caseOrders.map(o =>
      toUnifiedOrder(
        o.id,
        'case',
        o.facilityId,
        facilityNameById.get(o.facilityId),
        o.caseDatetime,
        o.status,
        o.items.length,
        o.items[0] ? productNameByJan.get(o.items[0].jan) : undefined
      )
    ),
    ...consumableOrders.map(o =>
      toUnifiedOrder(
        o.id,
        'consumable',
        o.facilityId,
        facilityNameById.get(o.facilityId),
        o.createdAt,
        o.status,
        o.items.length,
        o.items[0] ? consumableNameById.get(o.items[0].consumableId) : undefined
      )
    ),
    ...loanOrders.map(o =>
      toUnifiedOrder(
        o.id,
        'loan',
        o.facilityId,
        facilityNameById.get(o.facilityId),
        o.createdAt,
        o.status,
        o.items.length,
        o.items[0]?.name
      )
    ),
    ...loanReturns.map(o =>
      toUnifiedOrder(
        o.id,
        'loan_return',
        o.facilityId,
        facilityNameById.get(o.facilityId),
        o.returnDatetime,
        o.status,
        o.items.length,
        o.items[0] ? productNameByJan.get(o.items[0].jan) : undefined
      )
    ),
  ]

  // displayDatetime降順・同時刻はid昇順で安定ソート（SPEC.md受け入れ条件通り）
  orders.sort((a, b) => {
    const diff = new Date(b.displayDatetime).getTime() - new Date(a.displayDatetime).getTime()
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return { orders, errors }
}

async function fetchTopN<T extends { id: string }>(
  db: SupabaseClient,
  listFn: (
    db: SupabaseClient,
    facilityId: string,
    limit: number,
    offset: number,
    options?: OrderListFilterOptions
  ) => Promise<T[]>,
  facilityIds: string[],
  options: OrderListFilterOptions,
  dateOf: (t: T) => string
): Promise<T[]> {
  const perFacility = await Promise.all(
    facilityIds.map(facilityId => listFn(db, facilityId, LIMIT_PER_KIND, 0, options))
  )
  const merged = perFacility.flat()
  // WHY: admin全施設ファンアウト時、施設をまたいだ複数施設分のレコードをここで一旦マージしてから
  // 上位LIMIT_PER_KIND件に切り詰める。displayDatetimeが完全に同一（ミリ秒単位で一致）の異なる施設の
  // レコードが切り詰め境界をまたぐ場合、日時のみの比較では順序が不定（Array.sortの安定性はキー同値要素の
  // 相対順序を保証するが、その相対順序自体が各施設の返却順に依存し決定的ではない）。
  // SPEC.md受け入れ条件「同時刻はidを第2キーに安定ソート」を、最終マージ時だけでなくこの切り詰め時点でも
  // 満たすため、id昇順を第2キーとして併用する（型安全・データ層整合レビュー指摘対応）
  merged.sort((a, b) => {
    const diff = new Date(dateOf(b)).getTime() - new Date(dateOf(a)).getTime()
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return merged.slice(0, LIMIT_PER_KIND)
}

function unwrap<T>(result: PromiseSettledResult<T[]>, kind: OrderKind, errors: OrdersFetchError[]): T[] {
  if (result.status === 'fulfilled') return result.value
  errors.push({ kind, message: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  return []
}

function toUnifiedOrder(
  id: string,
  kind: OrderKind,
  facilityId: string,
  facilityName: string | undefined,
  displayDatetime: string,
  status: string,
  itemCount: number,
  firstItemName: string | undefined
): UnifiedOrder {
  return {
    id,
    kind,
    facilityId,
    facilityName,
    displayDatetime,
    status,
    summaryLabel: buildSummaryLabel(itemCount, firstItemName),
  }
}

// 代表製品名 + 残n件（SPEC.md表示カラム定義通り）
function buildSummaryLabel(itemCount: number, firstItemName: string | undefined): string {
  if (itemCount === 0) return '(品目なし)'
  const label = firstItemName && firstItemName.trim() ? firstItemName : '(品名不明)'
  return itemCount > 1 ? `${label} 他${itemCount - 1}件` : label
}

// products.jan→name / consumables.id→name のバッチ名前解決（IN句1本、N+1回避）
async function fetchNamesByKey(
  db: SupabaseClient,
  table: 'products' | 'consumables',
  keyColumn: 'jan' | 'id',
  keys: string[]
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map()
  const { data, error } = await db.from(table).select(`${keyColumn}, name`).in(keyColumn, keys)
  if (error) throw new Error(error.message)
  return new Map(
    ((data ?? []) as Record<string, unknown>[]).map(row => [asString(row[keyColumn]), asString(row.name)])
  )
}
