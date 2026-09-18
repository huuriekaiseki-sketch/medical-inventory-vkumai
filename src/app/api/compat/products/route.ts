import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { requiredUuidQuery } from '@/lib/validation/uuid'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { listProductsInCategory } from '@/lib/compatibilities/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'

// WHY: category_id はDB上uuid型のためAPI層で形式チェックしておくと不正値による
// 無駄なクエリ発行を防げる（SPEC Part2 Set D参照）
// WHY(2026-09-09): クエリは parseQuery で読み、UUID の判定は validation/uuid.ts に 1 つだけ。
//      文言は移行前と同じ（未指定でも形が違っても「categoryId は必須です」）
const compatProductsQuerySchema = z.object({
  categoryId: requiredUuidQuery('categoryId は必須です'),
})

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }

    const parsed = parseQuery(request, compatProductsQuerySchema)
    if (!parsed.ok) return parsed.response

    const products = await listProductsInCategory(db, parsed.data.categoryId)
    return NextResponse.json({ products })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '製品候補の取得に失敗しました'))
  }
}
