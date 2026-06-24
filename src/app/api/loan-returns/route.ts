import { NextRequest, NextResponse } from 'next/server'
import { createLoanReturn } from '@/lib/loan-returns/repository'
import type { LoanReturnInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanReturnInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.returnDatetime) return NextResponse.json({ error: '返却日時は必須です' }, { status: 400 })

  const input: LoanReturnInput = {
    returnDatetime: body.returnDatetime,
    items: body.items ?? [],
  }
  const loanReturn = await createLoanReturn(body.facilityId, input)
  return NextResponse.json({ loanReturn }, { status: 201 })
}
