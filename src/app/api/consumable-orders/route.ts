import { NextRequest, NextResponse } from 'next/server'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import { apiError } from '@/lib/api-error'
import type { ConsumableOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableOrderInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.items?.length) return apiError('発注物品を1つ以上選択してください', 400)

  try {
    const order = await createConsumableOrder(body.facilityId, { items: body.items })
    return NextResponse.json({ order, data: order }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '発注に失敗しました')
  }
}
