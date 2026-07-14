import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { fetchUnifiedOrders } from '@/lib/orders/unified-repository'
import { apiError } from '@/lib/api-error'
import type { OrderKind, OrdersFilter, OrdersGetResponse } from '@/types/order'

const VALID_ORDER_KINDS: OrderKind[] = ['case', 'consumable', 'loan', 'loan_return']

// WHY(issue #20 SET-D): 4種別(症例発注・消耗品発注・貸出発注・貸出返却)を横断取得するAPI。
// 認可はrequireAuth(401) → requireFacilityAccess(400/403)で既存パターンを踏襲し、
// RLSの`facility_member_or_admin`ポリシー（defense-in-depth）に加えてAPI層でも施設境界を担保する。
// 実データの並列取得・マージ・summaryLabel解決はsrc/lib/orders/unified-repository.tsに集約し、
// route.tsはパラメータの検証とレスポンス整形のみを担当する（SPEC.md Part2 SET-D）
export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try {
      user = await requireAuth(db)
    } catch {
      return apiError('認証が必要です', 401)
    }

    const facilityIdParam = request.nextUrl.searchParams.get('facility_id')
    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(db, user, facilityIdParam))
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }

    const dateFrom = request.nextUrl.searchParams.get('date_from')
    const dateTo = request.nextUrl.searchParams.get('date_to')
    const productSearch = request.nextUrl.searchParams.get('product_search')

    // WHY: order_kinds はCSV。パラメータ自体が未指定（null）の場合のみ「全種別対象」として
    // undefinedを渡す。パラメータが存在するが値が空（例: order_kinds=、全チェックボックス解除）
    // の場合は「0種別を明示的に選択した」とみなし、空配列をそのまま渡す（fetchUnifiedOrders側で
    // 空配列は「全種別」にフォールバックさせない。さもないと4種別すべてのチェックを外したのに
    // 実データは全種別表示されるというUI状態と矛盾する結果になる）。
    // 未知のkind文字列が1つでも混入していたらリクエスト全体を400で弾く
    // （黙って無視すると呼び出し元が意図しない種別で絞り込まれたことに気づけないため）
    const orderKindsParam = request.nextUrl.searchParams.get('order_kinds')
    let orderKinds: OrderKind[] | undefined
    if (orderKindsParam !== null) {
      const parsed = orderKindsParam
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const invalid = parsed.filter((k) => !VALID_ORDER_KINDS.includes(k as OrderKind))
      if (invalid.length > 0) {
        return apiError(`order_kinds に不正な値が含まれています: ${invalid.join(', ')}`, 400)
      }
      orderKinds = parsed as OrderKind[]
    }

    const filter: OrdersFilter = {
      facilityId: grantedFacilityId ?? undefined,
      dateFrom: dateFrom ?? undefined,
      dateTo: dateTo ?? undefined,
      productSearch: productSearch ?? undefined,
      orderKinds,
    }

    const result: OrdersGetResponse = await fetchUnifiedOrders(db, filter)
    return NextResponse.json(result)
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '発注履歴の取得に失敗しました')
  }
}
