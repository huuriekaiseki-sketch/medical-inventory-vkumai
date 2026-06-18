import { NextRequest, NextResponse } from 'next/server'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import type { HospitalPriceInput } from '@/types/hospitalPrice'

export async function GET() {
  const prices = await listHospitalPrices()
  return NextResponse.json({ prices })
}

export async function POST(request: NextRequest) {
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
    const price = await createHospitalPrice(input)
    return NextResponse.json({ price }, { status: 201 })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 404 })
      }
    }
    throw error
  }
}
