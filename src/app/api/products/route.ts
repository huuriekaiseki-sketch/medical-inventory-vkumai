import { NextRequest, NextResponse } from 'next/server'
import { listProducts, createProduct } from '@/lib/products/repository'
import { apiError } from '@/lib/api-error'
import type { ProductInput } from '@/types/product'

export async function GET() {
  try {
    const products = await listProducts()
    return NextResponse.json({ products, data: products })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '製品の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.jan || !input.ref) {
    return apiError('JAN と REF は必須です', 400)
  }

  try {
    const product = await createProduct(input)
    return NextResponse.json({ product, data: product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('JAN または REF が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '製品の作成に失敗しました')
  }
}
