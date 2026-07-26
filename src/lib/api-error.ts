import { NextResponse } from 'next/server'
import { ClientVisibleError } from './client-visible-error'

// WHY: 全 API のエラーレスポンスを { error: string } 形式に統一し、catch ごとの書きぶれを防ぐため
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status })
}

// WHY: Supabase/Postgresの生エラーメッセージにはテーブル名・制約名が含まれうるため、
//      クライアントに返す前に必ずこの関数を通してスキーマ情報の漏洩を防ぐ。
//      ClientVisibleErrorのインスタンス(repository層が明示的に翻訳済みと保証した安全なメッセージ)
//      だけをそのまま通し、それ以外は詳細をconsole.errorでサーバ側ログにのみ記録しfallbackを返す
//      (architecture review 2026-07-26 issue #3: 25箇所のraw error.message漏洩の修正)
export function toClientErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof ClientVisibleError) return error.message
  console.error(error)
  return fallbackMessage
}
