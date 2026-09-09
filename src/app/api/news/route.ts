import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listNewsFeed } from '@/lib/news/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { paginationQuerySchema } from '@/lib/api-pagination'
import { parseQuery } from '@/lib/validation/parse-query'

// WHY(2026-09-09、判定を共有へ移した): この route は limit / offset を**独自に**検証していて、
//      共通の `parsePagination` と条件が食い違っていた——あちらは `Number.isInteger` で小数を弾くが、
//      こちらは `Number.isFinite` だったので **`limit=1.5` が素通り**していた（E-053）。
//      判定は `paginationQuerySchema` の 1 か所に寄せ、**この route の意図（下限 0・上限 100）は
//      値として渡して保つ**。`limit=0` を許すのはここの仕様（テストで明示されている）。
const newsQuerySchema = z
  .object({ facilityId: z.string().optional() })
  .and(paginationQuerySchema({ limit: 20, offset: 0, minLimit: 0, maxLimit: 100 }))

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }

    const parsed = parseQuery(request, newsQuerySchema)
    if (!parsed.ok) return parsed.response
    const { facilityId, limit, offset } = parsed.data

    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(db, user, facilityId ?? null))
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facilityId は必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }

    const items = await listNewsFeed(db, { facilityId: grantedFacilityId, limit, offset })
    return NextResponse.json({ items })
  } catch (error) {
    return apiError(toClientErrorMessage(error, 'ニュースの取得に失敗しました'))
  }
}
