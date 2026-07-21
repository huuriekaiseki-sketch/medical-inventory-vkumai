import { NextResponse } from 'next/server'

// WHY: 全 API のエラーレスポンスを { error: string } 形式に統一し、catch ごとの書きぶれを防ぐため
export function apiError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status })
}

// WHY: Supabase/Postgresの生エラーメッセージにはテーブル名・制約名が含まれうるため、
//      クライアントに返す前に必ずこの関数を通してスキーマ情報の漏洩を防ぐ
export function sanitizeDbError(error: unknown, fallbackMessage: string): string {
  // 23505(unique_violation)・23503(foreign_key_violation)等、既存の個別コードハンドリングが
  // ある呼び出し元(repository層)ではその判定結果(Error.message)がここに渡ってくる。
  // ここでは生メッセージを返さずfallbackMessageのみ返す。詳細はconsole.errorでサーバ側ログにのみ記録する。
  console.error(error)
  return fallbackMessage
}
