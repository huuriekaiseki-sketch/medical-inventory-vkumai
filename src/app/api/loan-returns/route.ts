import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listLoanReturns, createLoanReturn } from '@/lib/loan-returns/repository'
import { apiError } from '@/lib/api-error'
import type { LoanReturnInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const facilityId = request.nextUrl.searchParams.get('facility_id')
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50')
  const offset = Number(request.nextUrl.searchParams.get('offset') ?? '0')
  try {
    const returns = await listLoanReturns(db, facilityId!, limit, offset)
    return NextResponse.json({ returns })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '返却一覧の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanReturnInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.returnDatetime) return apiError('返却日時は必須です', 400)
  if (body.items && body.items.some((item: { jan?: string }) => !item.jan?.trim())) {
    return apiError('JANは必須です', 400)
  }

  const input: LoanReturnInput = {
    returnDatetime: body.returnDatetime,
    items: body.items ?? [],
  }
  try {
    const db = await createServerSupabase()
    const loanReturn = await createLoanReturn(db, body.facilityId, input)
    return NextResponse.json({ loanReturn }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '返却に失敗しました')
  }
}
