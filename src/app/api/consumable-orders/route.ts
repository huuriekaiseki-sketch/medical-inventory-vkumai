import { NextRequest, NextResponse } from 'next/server'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import type { ConsumableOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.items?.length) return NextResponse.json({ error: '発注物品を1つ以上選択してください' }, { status: 400 })

  const order = await createConsumableOrder(body.facilityId, { items: body.items })
  return NextResponse.json({ order }, { status: 201 })
}
