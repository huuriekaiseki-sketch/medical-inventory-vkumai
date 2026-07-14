import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import { apiError } from '@/lib/api-error'
import type { FacilityInput } from '@/types/facility'

// WHY(issue #20 統合ゲート・重複・過剰実装レビュー対応): このエンドポイントは
// listFacilities(db) の全件を非adminにもそのまま返す（施設管理画面など「全施設を見せてよい」
// 用途向け）。`{ facilities, isAdmin }` という同一形状を返す GET /api/user-facilities は
// 非adminには所属施設のみへ絞り込む別エンドポイントであり、「非adminは自分の所属施設のみ
// 選択可能」という制約が必要な画面（/orders の施設フィルタ等）はそちらを使うこと。
// 使い分けの詳細は src/app/api/user-facilities/route.ts のコメントを参照
export async function GET() {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facilities = await listFacilities(db)
    // WHY: フロントエンドが「全施設」表示オプションを出すかどうかの判定に使う。
    // require-facility-access.ts の resolveIsAdmin と同じ判定にすることで、
    // UIが「全施設」を選べるのにAPIがfacilityId必須で弾く、という不整合を防ぐ（issue #40）
    const isAdmin = await resolveIsAdmin(db, user)
    return NextResponse.json({ facilities, isAdmin })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '施設の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.name?.trim()) {
    return apiError('施設名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facility = await createFacility(db, input)
    return NextResponse.json({ facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('施設名が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '施設の作成に失敗しました')
  }
}
