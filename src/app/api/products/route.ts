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

  if (!input.jan || !input.ref) {
    return NextResponse.json({ error: 'JAN と REF は必須です' }, { status: 400 })
  }

  try {
    const product = await createProduct(input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: 'JAN または REF が重複しています' }, { status: 409 })
    }
    throw error
  }
}
