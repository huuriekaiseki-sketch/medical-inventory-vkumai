import { NextRequest, NextResponse } from 'next/server'
import { listCategories, createCategory } from '@/lib/categories/repository'
import type { CategoryInput } from '@/types/category'

export async function GET() {
  const categories = await listCategories()
  return NextResponse.json({ categories })
}

export async function POST(request: NextRequest) {
  let input: CategoryInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.name?.trim()) {
    return NextResponse.json({ error: 'カテゴリ名は必須です' }, { status: 400 })
  }

  try {
    const category = await createCategory(input)
    return NextResponse.json({ category }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: 'カテゴリ名が重複しています' }, { status: 409 })
    }
    throw error
  }
}
