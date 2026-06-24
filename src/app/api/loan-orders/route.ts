import { NextRequest, NextResponse } from 'next/server'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import type { LoanOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.procedureName?.trim()) return NextResponse.json({ error: '手技名は必須です' }, { status: 400 })
  if (!body.maker?.trim()) return NextResponse.json({ error: 'メーカー名は必須です' }, { status: 400 })
  if (body.items && body.items.some((item: { name?: string }) => !item.name?.trim())) {
    return NextResponse.json({ error: '品名は必須です' }, { status: 400 })
  }

  const input: LoanOrderInput = {
    procedureName: body.procedureName,
    maker: body.maker,
    items: body.items ?? [],
  }
  const order = await createLoanOrder(body.facilityId, input)
  return NextResponse.json({ order }, { status: 201 })
}
