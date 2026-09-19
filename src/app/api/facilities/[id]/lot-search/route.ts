import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { parseQuery } from '@/lib/validation/parse-query'
import { lotSearchQuerySchema } from '@/lib/validation/schemas'
import { searchLotItems } from '@/lib/lot-search/repository'
import { normalizeLotInput } from '@/lib/lot-search/normalize'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'
import type { LotSearchApiErrorResponse, LotSearchApiQuery, LotSearchApiResponse } from '@/types/order'

// WHY(SPEC Part2 セットB): ロット検索は「その施設 1 つ」だけを見る（決定 1 = (a)）。
//      URL の [id] が施設 ID で、query には facility_id を持たない。ロールでは分けない
//      （決定 8 = (a)。viewer も含め、既に見られる明細を横断して引くだけ）。
//
// WHY(requireFacilityAccess に facilityIdRequired: true): [id] は常に非空文字列のはずだが、
//      admin が facility_id 無しで全施設横断できてしまう抜け道（P-002 の対象外にする）を
//      route 側の判定に分散させず、唯一の入口（require-facility-access.ts）に寄せる。
export async function GET(
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse<LotSearchApiResponse> | NextResponse<LotSearchApiErrorResponse>> {
  const { id: facilityId } = await context.params

  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }

  try {
    await requireFacilityAccess(db, user, facilityId, { facilityIdRequired: true })
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') {
      return apiError('施設IDは必須です', 400)
    }
    return apiError('アクセス権限がありません', 403)
  }

  const parsed = parseQuery(request, lotSearchQuerySchema)
  if (!parsed.ok) return parsed.response

  // WHY(normalizeLotInput、決定 3 = (b)): UI と API の両方が同じ正規化を通す
  //      （前後の空白だけを落とす）。API を直接叩かれた場合も同じ扱いにする
  const normalizedLot = normalizeLotInput(parsed.data.lot)

  // WHY(LotSearchApiQuery を明示的に組み立てる): facilityId は [id]、lot は query 由来と
  //      出どころが分かれているため、repository へ渡す前に「パース・正規化済みのクエリ」を
  //      1 つの型に確定させる（型を素通りさせない。未使用のまま宣言だけ残さない）。
  const query: LotSearchApiQuery = { facilityId, lot: normalizedLot }

  try {
    const { items, truncated } = await searchLotItems(db, query.facilityId, query.lot)
    const body: LotSearchApiResponse = { items, truncated }
    return NextResponse.json(body)
  } catch (error) {
    return repositoryError(error, 'ロット検索に失敗しました')
  }
}
