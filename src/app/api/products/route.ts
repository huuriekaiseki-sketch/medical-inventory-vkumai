import { NextRequest, NextResponse } from 'next/server'
import { listProducts, createProduct } from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

export async function GET() {
  const products = await listProducts()
  return NextResponse.json({ products })
}

export async function POST(request: NextRequest) {
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.name || !input.code || !input.category || !input.unit) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const product = await createProduct(input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: '製品コードが重複しています' }, { status: 409 })
    }
    throw error
  }
}
