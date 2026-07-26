import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { listProductsInCategory } from '@/lib/compatibilities/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'

// WHY: category_id はDB上uuid型のためAPI層で形式チェックしておくと不正値による
// 無駄なクエリ発行を防げる（SPEC Part2 Set D参照）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }

    const categoryId = request.nextUrl.searchParams.get('categoryId')

    if (!categoryId || !UUID_RE.test(categoryId)) {
      return apiError('categoryId は必須です', 400)
    }

    const products = await listProductsInCategory(db, categoryId)
    return NextResponse.json({ products })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '製品候補の取得に失敗しました'))
  }
}
