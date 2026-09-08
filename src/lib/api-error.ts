import { NextResponse } from 'next/server'
import { ClientVisibleError } from './client-visible-error'
import { logServerError } from './log-safe'

// WHY: 全 API のエラーレスポンスを { error: string } 形式に統一し、catch ごとの書きぶれを防ぐため
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status })
}

// WHY(#757-32 Q-002): requireAuth は「未認証」と「回数の上限を超えた」の 2 つで throw する。
//      route ごとに catch を書くと、必ずどれかが上限を 401 のまま返して原因が分からなくなるので、
//      投げられたエラーから応答を作る場所を 1 か所にする。
//      429 を返すのは、人が決めた「拒否して記録に残す」（黙って通さない・黙って捨てない）ため。
//      構造テスト scripts/check-rate-limit-coverage.test.sh が、requireAuth を使う route が
//      この関数を通しているかを機械検査する。
export function authGuardError(error: unknown) {
  if (error instanceof Error && error.message === 'RATE_LIMITED') {
    return apiError('リクエストが多すぎます。しばらく待ってからやり直してください', 429)
  }
  return apiError('認証が必要です', 401)
}

/**
 * repository 層のエラーから応答を作る（書き込み経路用）。
 *
 * WHY: ClientVisibleError は「利用者に見せてよい」と repository が翻訳済みのエラーで、
 *      中身は**利用者の入力が原因**（未登録の JAN・業務ルール違反・重複）。これを 500 で返すと、
 *      利用者が自分で直せる間違いが「サーバーの故障」に見える。
 *      2026-09-08 の時点で 400 を返していたのは短貸返却だけで、症例発注・短貸発注・
 *      消耗品発注は文言だけ差し替えて 500 のままだった。判定を 1 か所に集める。
 */
export function repositoryError(error: unknown, fallbackMessage: string) {
  if (error instanceof ClientVisibleError) return apiError(error.message, 400)
  logServerError('api', error)
  return apiError(fallbackMessage, 500)
}

// WHY: Supabase/Postgresの生エラーメッセージにはテーブル名・制約名が含まれうるため、
//      クライアントに返す前に必ずこの関数を通してスキーマ情報の漏洩を防ぐ。
//      ClientVisibleErrorのインスタンス(repository層が明示的に翻訳済みと保証した安全なメッセージ)
//      だけをそのまま通し、それ以外はサーバ側ログにのみ記録しfallbackを返す
//      (architecture review 2026-07-26 issue #3: 25箇所のraw error.message漏洩の修正)
// WHY(logServerError): サーバ側ログも施設の外に出る場所。PostgreSQL の DETAIL（Failing row contains ...）
//      には患者 ID 等の行の中身が入るので、伏せてから出す（issue #757 の 5。src/lib/log-safe.ts）
export function toClientErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof ClientVisibleError) return error.message
  logServerError('api', error)
  return fallbackMessage
}
