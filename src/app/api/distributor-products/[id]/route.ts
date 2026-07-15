import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { getDistributorProduct, updateDistributorProduct, deleteDistributorProduct } from '@/lib/distributor-products/repository'
import { apiError } from '@/lib/api-error'
import type { DistributorProductInput } from '@/types/distributorProduct'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const item = await getDistributorProduct(db, id)
  if (!item) {
    return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ item })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.categoryId) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const item = await updateDistributorProduct(db, id, input)
    return NextResponse.json({ item })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('代理店商品ID')) {
        return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('製品ID')) {
        return NextResponse.json({ error: '指定された製品が見つかりません' }, { status: 404 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    await deleteDistributorProduct(db, id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
