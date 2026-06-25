import { NextRequest, NextResponse } from 'next/server'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import { apiError } from '@/lib/api-error'
import type { LoanOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanOrderInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.procedureName?.trim()) return apiError('手技名は必須です', 400)
  if (!body.maker?.trim()) return apiError('メーカー名は必須です', 400)
  if (body.items && body.items.some((item: { name?: string }) => !item.name?.trim())) {
    return apiError('品名は必須です', 400)
  }

  const input: LoanOrderInput = {
    procedureName: body.procedureName,
    maker: body.maker,
    items: body.items ?? [],
  }
  try {
    const order = await createLoanOrder(body.facilityId, input)
    return NextResponse.json({ order, data: order }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '発注に失敗しました')
  }
}
