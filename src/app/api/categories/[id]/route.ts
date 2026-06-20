import { NextRequest, NextResponse } from 'next/server'
import { getCategory, updateCategory, deleteCategory } from '@/lib/categories/repository'
import type { CategoryInput } from '@/types/category'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const category = await getCategory(id)
  if (!category) {
    return NextResponse.json({ error: 'カテゴリが見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ category })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
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
    const category = await updateCategory(id, input)
    return NextResponse.json({ category })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: 'カテゴリが見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: 'カテゴリ名が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteCategory(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: 'カテゴリが見つかりません' }, { status: 404 })
      }
      if (error.message.includes('使用中のため削除できません')) {
        return NextResponse.json({ error: '使用中のため削除できません' }, { status: 409 })
      }
    }
    throw error
  }
}
