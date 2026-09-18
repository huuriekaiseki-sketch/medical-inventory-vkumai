import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { getDistributorProduct, updateDistributorProduct, deleteDistributorProduct } from '@/lib/distributor-products/repository'
import { authGuardError, apiError } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'
import { parseBody } from '@/lib/validation/parse-body'
import { distributorProductInputSchema } from '@/lib/validation/schemas'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  try { await requireAuth(db) } catch (e) { return authGuardError(e) }
  const item = await getDistributorProduct(db, id)
  if (!item) {
    return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ item })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const parsed = await parseBody(request, distributorProductInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
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
