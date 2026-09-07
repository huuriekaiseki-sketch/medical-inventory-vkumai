import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { parsePagination } from '@/lib/api-pagination'
import { isValidDateString } from '@/lib/jst-date-range'
import { listAccessDenials, listAuditLog } from '@/lib/audit/repository'
import { AUDIT_KINDS, type AuditApiErrorResponse, type AuditApiResponse, type AuditKind, type AuditQuery } from '@/types/audit'

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

  const params = request.nextUrl.searchParams
  const kindParam = params.get('kind') ?? 'changes'
  if (!AUDIT_KINDS.includes(kindParam as AuditKind)) {
    return auditApiError('kind は changes / denials のいずれかで指定してください', 400)
  }
  const kind = kindParam as AuditKind

  const dateFrom = params.get('date_from')
  const dateTo = params.get('date_to')
  if (dateFrom && !isValidDateString(dateFrom)) {
    return auditApiError('date_from は YYYY-MM-DD 形式で指定してください', 400)
  }
  if (dateTo && !isValidDateString(dateTo)) {
    return auditApiError('date_to は YYYY-MM-DD 形式で指定してください', 400)
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return auditApiError('date_from は date_to 以前の日付を指定してください', 400)
  }

  const pagination = parsePagination(params)
  if (!pagination.ok) return pagination.response

  const query: AuditQuery = {
    kind,
    limit: pagination.limit,
    offset: pagination.offset,
    ...(params.get('facility_id') ? { facilityId: params.get('facility_id')! } : {}),
    ...(params.get('actor_id') ? { actorId: params.get('actor_id')! } : {}),
    ...(params.get('table_name') ? { tableName: params.get('table_name')! } : {}),
    ...(params.get('guard') ? { guard: params.get('guard')! } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
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
