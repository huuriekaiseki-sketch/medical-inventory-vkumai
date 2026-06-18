import { NextRequest, NextResponse } from 'next/server'
import { getProduct, updateProduct, deleteProduct } from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const product = await getProduct(id)
  if (!product) {
    return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ product })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
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
    const product = await updateProduct(id, input)
    return NextResponse.json({ product })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: 'JAN または REF が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteProduct(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
