import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'
import { parseBody } from '@/lib/validation/parse-body'
import { userFacilityAssignSchema, userFacilityRemoveSchema } from '@/lib/validation/schemas'

// WHY(service_role をやめて利用者の JWT で書く。2026-09-07、P-035):
//   ここは「誰がどの施設で何をできるか」を書き換える、いちばん重い操作。
//   以前は requireAdmin() のあと service_role（RLS を通らない鍵）で書いていた。そのため
//     (1) マスタの書き込みには aal2 が要る（P-033）のに、**権限の付け替えには要らなかった**。
//         パスワードだけ奪われた admin が、共犯者を admin に昇格させられた。
//     (2) 認可の判定と書き込みが別々の往復になり、判定の後に admin を外されても書き切れた
//         （実測: 降格と同時に走った 12 本のうち 8 本が通った。窓 約 25 ms）。
//   利用者の JWT で書けば、RLS の `is_admin() AND has_aal2()`（20260907030000）が
//   **書き込みと同じ文の中で**評価されるので、両方とも消える。
//
// WHY(0 行を成功にしない): RLS に弾かれた UPDATE / DELETE は error を返さず、
//   単に 0 行になる。`.select()` で書けた行を受け取り、0 行なら 403 を返す
//   （「成功したのに何も起きていない」を作らない）。
//
// requireAdmin() は残す。RLS だけでも守れるが、権限が無いときに 403 と分かる応答を返すため
//   （RLS 任せだと 0 行＝理由の分からない失敗になる）。拒否の記録もここで残る。

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, userFacilityAssignSchema)
  if (!parsed.ok) return parsed.response
  const { userId, facilityId, role } = parsed.data

  const db = await createServerSupabase()
  const { data, error } = await db
    .from('user_facilities')
    .upsert(
      { user_id: userId, facility_id: facilityId, role: role ?? 'staff' },
      { onConflict: 'user_id,facility_id' }
    )
    .select('user_id')

  if (error) return apiError(toClientErrorMessage(error, '施設の割り当てに失敗しました'))
  if (!data || data.length === 0) {
    return apiError('権限がありません（多要素認証が必要な場合があります）', 403)
  }

  return NextResponse.json({ message: '施設を割り当てました' })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, userFacilityRemoveSchema)
  if (!parsed.ok) return parsed.response
  const { userId, facilityId } = parsed.data

  const db = await createServerSupabase()
  const { data, error } = await db
    .from('user_facilities')
    .delete()
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
    .select('user_id')

  if (error) return apiError(toClientErrorMessage(error, '施設の割り当て解除に失敗しました'))
  if (!data || data.length === 0) {
    return apiError('権限がありません（多要素認証が必要な場合があります）', 403)
  }

  return NextResponse.json({ message: '施設の割り当てを解除しました' })
}
