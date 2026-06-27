import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { createLoanReturn } from '@/lib/loan-returns/repository'
import { apiError } from '@/lib/api-error'
import type { LoanReturnInput } from '@/types/order'

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
    return NextResponse.json({ loanReturn, data: loanReturn }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '返却に失敗しました')
  }
}
