import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 施設の「未返却」の短貸発注の件数。
 *
 * WHY(2026-09-08 に件数差からやめた): 以前は
 * 「submitted の発注の数 − returned の返却の数」で近似していたが、
 * **一覧のバッジと判定が違っていた**。バッジ（`src/lib/orders/repository.ts`）は
 * `loan_returns.loan_order_id` の紐付けを見るのに対し、この件数は紐付けを一切見ない。
 * その結果:
 *   - 対象を選ばずに返却を作ると、**件数は減るのにバッジは残る**
 *   - `loan_order_id` が NULL の返却は部分 UNIQUE の対象外で何件でも作れるので、
 *     3 件作れば件数が 3 減る（実態と無関係に減る）
 * 数え方を紐付けベースへ揃え、「どの発注が未返却か」と「何件あるか」が必ず一致するようにした。
 *
 * WHY(JS で数えない): 全件を取って数えると PostgREST の既定上限（1,000 行）で切り落とされ、
 * 件数が静かに小さく出る（E-023 と同じ形）。埋め込みの anti-join を DB 側で数える。
 * `loan_returns=is.null` が本当に親を絞ることは 2026-09-08 に実測で確認した
 * （返却を 1 件紐付けると 13 → 12、外すと 13 に戻る）。
 *
 * 限界: 短貸発注 1 件に返却は 1 件までという今のスキーマ（`loan_returns.loan_order_id` の
 * 部分 UNIQUE、20260828000001）を前提にしている。**分割返却は表現できない**ので、
 * 一部だけ返した発注も「返却済み」として数から外れる。分割返却の運用があることは
 * 2026-09-08 に確認済みで、別件として扱う。
 */
export async function getLoanOutstandingCount(
  db: SupabaseClient,
  facilityId: string
): Promise<number> {
  const { count, error } = await db
    .from('loan_orders')
    .select('id, loan_returns!left(id)', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('status', 'submitted')
    .is('loan_returns', null)
  if (error) throw new Error(error.message)
  return count ?? 0
}
