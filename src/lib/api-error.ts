import { NextResponse } from 'next/server'
import { ClientVisibleError } from './client-visible-error'
import { logServerError } from './log-safe'

// WHY: 全 API のエラーレスポンスを { error: string } 形式に統一し、catch ごとの書きぶれを防ぐため
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status })
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
