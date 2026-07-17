// issue #431のrecallベンチマーク用fixture。既知の失敗パターン
// （docs/agents/known-failure-patterns.md「動いたからOKでfacility_idフィルタ漏れ・
// RLS未設定を見逃す」issue #24再発防止）を意図的に再現している:
// requireAuth/requireFacilityAccessによる認可チェックが一切無いまま、
// パスパラメータのidをそのままDBクエリに渡している。
import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = await createServerSupabase()
  const { data, error } = await db.from('eval_fixture_recall_items').select('*').eq('id', id).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
