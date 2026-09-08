import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 施設の「未返却」の短貸発注の件数。
 *
 * WHY(2026-09-08 に 2 回変えた):
 *   1. もとは「submitted の発注の数 − returned の返却の数」で近似していた。
 *      一覧のバッジ（紐付けを見る）と判定が違い、**対象を選ばない返却でも件数が減っていた**（E-053）。
 *   2. 紐付けベースに揃えたあと、分割返却を表せるようにした（20260908030000）。
 *      「返却が 1 件でもあるか」で見ると**一部だけ返した発注が消えてしまう**ので、
 *      いまは **まだ返っていない数量が残っている発注の件数** を数える。
 *
 * WHY(RPC で数える): 判定が「明細ごとの数量 − 紐付いた返却の合計」になり、
 * PostgREST の埋め込みだけでは書けない。アプリで全件を取って数えると
 * 既定上限（1,000 行）で静かに切り落とされる（E-023 と同じ形）。DB 側で数える。
 *
 * WHY(SECURITY DEFINER にしない): `loan_outstanding_count` は呼び出した利用者の権限で走るので
 * RLS がそのまま効き、自分の施設の行しか数えない。他施設の ID を渡しても 0 になる。
 *
 * 限界: 紐付けの無い返却（対象の短貸発注を選ばずに記録したもの）は残数に影響しない。
 * 「とりあえず返却だけ記録する」経路を塞がないための意図的な扱い。
 */
export async function getLoanOutstandingCount(
  db: SupabaseClient,
  facilityId: string
): Promise<number> {
  const { data, error } = await db.rpc('loan_outstanding_count', { p_facility_id: facilityId })
  if (error) throw new Error(error.message)
  return typeof data === 'number' ? data : 0
}
