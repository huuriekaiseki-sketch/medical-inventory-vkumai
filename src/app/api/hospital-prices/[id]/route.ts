import { NextRequest, NextResponse } from 'next/server'
import { getHospitalPrice, updateHospitalPrice, deleteHospitalPrice } from '@/lib/hospital-prices/repository'
import type { HospitalPriceInput } from '@/types/hospitalPrice'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const price = await getHospitalPrice(id)
  if (!price) {
    return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ price })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.deliveryPrice === undefined) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const price = await updateHospitalPrice(id, input)
    return NextResponse.json({ price })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('病院別価格ID')) {
        return NextResponse.json({ error: '価格情報が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('代理店商品または施設が存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteHospitalPrice(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
