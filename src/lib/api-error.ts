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
