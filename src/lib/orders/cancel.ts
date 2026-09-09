import type { SupabaseClient } from '@supabase/supabase-js'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { toRepositoryError } from '@/lib/invariant-error'

/**
 * 発注 3 種の取り消し（E-056 の残り。返却は `loan-returns/repository.ts` の `cancelLoanReturn`）。
 *
 * WHY(3 表で 1 つにする): 症例・消耗品・短貸で同じことを 3 回書くと、
 *      3 か所のうち 1 つだけ直し忘れる形の失敗が入る（このリポジトリで何度も踏んでいる型）。
 *      表ごとに違うのは名前だけなので、表名を引数に取って 1 か所にまとめる。
 *
 * WHY(削除しない): 行を残して `cancelled` にする。誰がいつ何を取り消したかを残すため
 *      （status の変更は監査トリガーが記録する）。行を消すと業務の一覧から消えてしまい、
 *      「間違えた発注があった」こと自体が追えなくなる。
 *
 * WHY(施設を明示的に条件へ入れる): RLS だけに頼らず `facility_id` を条件に入れて
 *      「存在するが他施設のもの」を確実に弾く（多層防御）。
 *      RLS は拒否ではなく 0 行にするので、0 行を「見つからない」に写す。
 */
export const CANCELLABLE_ORDER_TABLES = ['case_orders', 'consumable_orders', 'loan_orders'] as const
export type CancellableOrderTable = (typeof CANCELLABLE_ORDER_TABLES)[number]

/** 取り消そうとした発注が見つからない（他施設のものを含む）。route が 404 に写す */
export const ORDER_NOT_FOUND_ERROR = '発注が見つかりません'
/** すでに取り消し済み。route が 409 に写す */
export const ORDER_ALREADY_CANCELLED_ERROR = 'この発注はすでに取り消されています'
/** 返却が残っている短貸発注。route が 409 に写す（I-022） */
export const ORDER_HAS_RETURNS_ERROR =
  'この発注には返却の記録があるため取り消せません。先に返却を取り消してください'

/**
 * 「返却が残っているので取り消せない」を DB のエラーから見分ける。
 *
 * WHY(判定を持たずに文言だけ写す): 生きた返却の数え方は残数（`loan_outstanding_count`）と
 *      揃っている必要があり、**同じ問いの答えを 2 か所に置くと必ず食い違う**（E-053）。
 *      判定は DB のトリガー（`enforce_loan_order_cancellable`、20260909050000）に 1 つだけ置き、
 *      ここは利用者に読める一文へ写すだけにする。
 *
 * WHY(コードではなく文言で見分ける): 23514 は業務不変条件すべてに共通で、
 *      これだけでは「状態は戻せません」の汎用文になってしまい、
 *      **何をすれば直せるか**が伝わらない（C-023 と同じ、合図が同じだと層を見分けられない形）。
 */
function isActiveReturnsViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23514' && /has active returns/.test(error.message ?? '')
}

export interface CancelledOrder {
  id: string
  status: string
}

export async function cancelOrder(
  db: SupabaseClient,
  table: CancellableOrderTable,
  facilityId: string,
  id: string
): Promise<CancelledOrder> {
  const { data: current, error: readError } = await db
    .from(table)
    .select('id, status')
    .eq('id', id)
    .eq('facility_id', facilityId)
    .maybeSingle()
  if (readError) throw toRepositoryError(readError)
  if (!current) throw new ClientVisibleError(ORDER_NOT_FOUND_ERROR)
  if ((current as { status?: unknown }).status === 'cancelled') {
    throw new ClientVisibleError(ORDER_ALREADY_CANCELLED_ERROR)
  }

  const { data, error } = await db
    .from(table)
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('facility_id', facilityId)
    .select('id, status')
    .maybeSingle()
  if (isActiveReturnsViolation(error)) throw new ClientVisibleError(ORDER_HAS_RETURNS_ERROR)
  if (error) throw toRepositoryError(error)
  // RLS で 0 行になった場合（読めるが書けない立場＝viewer）
  if (!data) throw new ClientVisibleError('発注を取り消す権限がありません')

  const row = data as { id: string; status: string }
  return { id: row.id, status: row.status }
}
