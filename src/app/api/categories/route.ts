import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { listCategories, createCategory } from '@/lib/categories/repository'
import { apiError } from '@/lib/api-error'
import type { CategoryInput } from '@/types/category'

export async function GET() {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const categories = await listCategories(db)
    return NextResponse.json({ categories })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'カテゴリの取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: CategoryInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.name?.trim()) {
    return apiError('カテゴリ名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const category = await createCategory(db, input)
    return NextResponse.json({ category }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('カテゴリ名が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : 'カテゴリの作成に失敗しました')
  }
}
