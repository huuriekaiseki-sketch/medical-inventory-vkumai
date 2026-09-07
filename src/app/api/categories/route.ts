import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listCategories, createCategory } from '@/lib/categories/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { categoryInputSchema } from '@/lib/validation/schemas'
import { parseBody } from '@/lib/validation/parse-body'

export async function GET() {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }
    const categories = await listCategories(db)
    return NextResponse.json({ categories })
  } catch (error) {
    return apiError(toClientErrorMessage(error, 'カテゴリの取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  // WHY(#757-20): 本文を読む唯一の入口。上限は aidd.config.json の limits.textLength
  const parsed = await parseBody(request, categoryInputSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    // WHY: 表の列は NULL 可。zod は空文字を undefined にするので、DB の形（null）へ揃える
    const category = await createCategory(db, { ...input, description: input.description ?? null })
    return NextResponse.json({ category }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('カテゴリ名が重複しています', 409)
    }
    return apiError(toClientErrorMessage(error, 'カテゴリの作成に失敗しました'))
  }
}
