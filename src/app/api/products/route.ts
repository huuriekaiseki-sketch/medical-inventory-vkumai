import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listProducts, createProduct } from '@/lib/products/repository'
import { apiError } from '@/lib/api-error'
import type { ProductInput } from '@/types/product'

export async function GET() {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const products = await listProducts(db)
    return NextResponse.json({ products })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '製品の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.jan || !input.ref) {
    return apiError('JAN と REF は必須です', 400)
  }

  if (!input.name || !input.name.trim()) {
    return apiError('製品名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const product = await createProduct(db, input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('JAN または REF が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '製品の作成に失敗しました')
  }
}
