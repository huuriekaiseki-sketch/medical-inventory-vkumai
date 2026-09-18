import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { paginationQueryShape } from '@/lib/api-pagination'
import { dateRangeShape, refineDateRange } from '@/lib/jst-date-range'
import { parseQuery } from '@/lib/validation/parse-query'
import { listAccessDenials, listAuditLog } from '@/lib/audit/repository'
import { AUDIT_KINDS, type AuditApiErrorResponse, type AuditApiResponse, type AuditQuery } from '@/types/audit'

// WHY(2026-09-09、クエリの読み取りを唯一の入口へ): この route はクエリを 7 か所で生読みし、
//      kind と日付だけを手書きで検証、`facility_id` / `actor_id` / `table_name` / `guard` は
//      **素通し**だった（壊れた値は 400 ではなく 500 になる）。
//      日付の 3 条件はレポート route（/api/admin/reports）と**同じ文言で 2 回**書かれており、
//      片方だけ直せば食い違う形だった（E-053 の予備軍）。判定を共有へ寄せる。
//
// WHY(自由入力に上限を付ける): `table_name` / `guard` は絞り込みの語で、そのまま DB のクエリへ渡る。
//      語彙を閉じるところまでは踏み込まないが（表名は増えるため）、**長さの上限**は入れる。
//      入口で止めないと、長い文字列がそのまま問い合わせに乗る。
const auditQuerySchema = refineDateRange(
  z.object({
    kind: z
      .enum(AUDIT_KINDS, { error: 'kind は changes / denials のいずれかで指定してください' })
      .optional(),
    facility_id: z.string().max(200, { error: 'facility_id が長すぎます' }).optional(),
    actor_id: z.string().max(200, { error: 'actor_id が長すぎます' }).optional(),
    table_name: z.string().max(200, { error: 'table_name が長すぎます' }).optional(),
    guard: z.string().max(200, { error: 'guard が長すぎます' }).optional(),
    ...dateRangeShape,
    ...paginationQueryShape(),
  })
)

// WHY: apiError は共通の { error: string } を返すが、この route の型と一致することを
//      コンパイル時に保証するためにラップする（他の admin route と同じ書き方）
function auditApiError(message: string, status = 500): NextResponse<AuditApiErrorResponse> {
  return apiError(message, status)
}

// GET /api/admin/audit?kind=changes|denials&facility_id=&actor_id=&table_name=&guard=&date_from=&date_to=&limit=&offset=
//
// WHY(#757-4・24): 監査ログと拒否の記録は入れたが、読む手段が DB を直接叩くことしか無かった。
//      事故のあとに「誰が・いつ・何をしたか」「誰がどこで弾かれたか」を説明できるように、
//      admin が画面から辿れる窓口を 1 つ開ける。
//
// WHY(件数の上限は共通のものを使う): 1 回に返す件数は parsePagination（1〜200、既定 50、
//      offset は 100,000 まで）に任せる。新しい上限をここで決めない（quota-inventory の Q-001）。
export async function GET(
  request: NextRequest
): Promise<NextResponse<AuditApiResponse> | NextResponse<AuditApiErrorResponse>> {
  const db = await createServerSupabase()

  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }

  // WHY: requireAdmin() は未認証と非 admin をどちらも null で返して 401/403 を区別できない。
  //      レポート route と同じく resolveIsAdmin で分ける
  const isAdmin = await resolveIsAdmin(db, user)
  if (!isAdmin) return auditApiError('権限がありません', 403)

  const parsed = parseQuery(request, auditQuerySchema)
  if (!parsed.ok) return parsed.response
  const p = parsed.data
  const kind = p.kind ?? 'changes'

  const query: AuditQuery = {
    kind,
    limit: p.limit,
    offset: p.offset,
    ...(p.facility_id ? { facilityId: p.facility_id } : {}),
    ...(p.actor_id ? { actorId: p.actor_id } : {}),
    ...(p.table_name ? { tableName: p.table_name } : {}),
    ...(p.guard ? { guard: p.guard } : {}),
    ...(p.date_from ? { dateFrom: p.date_from } : {}),
    ...(p.date_to ? { dateTo: p.date_to } : {}),
  }

  try {
    if (kind === 'denials') {
      const denials = await listAccessDenials(db, query)
      return NextResponse.json({ kind, denials })
    }
    const changes = await listAuditLog(db, query)
    return NextResponse.json({ kind, changes })
  } catch (error) {
    // WHY: 拒否の記録は aal2 まで上げた admin しか読めない。MFA を通していない admin には
    //      RLS が 0 件を返すだけで例外にならないが、権限まわりのエラーが漏れてきたときは
    //      500 で隠さず 403 に変換する（レポート route と同じ扱い）
    const message = error instanceof Error ? error.message : ''
    if (message.includes('permission denied')) {
      return auditApiError('権限がありません', 403)
    }
    return auditApiError(toClientErrorMessage(error, '監査ログの取得に失敗しました'))
  }
}
