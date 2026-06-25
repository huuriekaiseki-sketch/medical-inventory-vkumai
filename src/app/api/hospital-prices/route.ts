import { NextRequest, NextResponse } from 'next/server'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import { apiError } from '@/lib/api-error'
import type { HospitalPriceInput } from '@/types/hospitalPrice'

export async function GET() {
  try {
    const prices = await listHospitalPrices()
    return NextResponse.json({ prices, data: prices })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '価格の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.purchasePrice === null ||
      input.deliveryPrice === undefined || input.deliveryPrice === null) {
    return apiError('必須項目が未入力です', 400)
  }

  try {
    const price = await createHospitalPrice(input)
    return NextResponse.json({ price, data: price }, { status: 201 })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('既に登録されています')) {
        return apiError(error.message, 409)
      }
      if (error.message.includes('存在しません')) {
        return apiError(error.message, 422)
      }
      return apiError(error.message)
    }
    return apiError('価格の作成に失敗しました')
  }
}
