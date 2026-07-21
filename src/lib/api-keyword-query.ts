import { NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'

// WHY: api-pagination.ts の parsePagination と対称な設計。keyword クエリパラメータの長さ
// 上限バリデーションを各 route.ts に重複実装させないための共有ヘルパー（SPEC Set A）。
export type KeywordQueryResult =
  | { ok: true; keyword?: string }
  | { ok: false; response: NextResponse<{ error: string }> }

export function parseKeyword(
  params: URLSearchParams,
  opts?: { maxLength?: number }
): KeywordQueryResult {
  const maxLength = opts?.maxLength ?? 100
  const raw = params.get('keyword') ?? ''
  // WHY: 長さ上限チェックはtrim後の実際に検索へ使う値に対して行う（レビュー指摘: 正しさ minor）。
  //      raw（trim前）基準だと前後空白だけで100文字を超えるような入力を不当に400で弾いてしまう
  const trimmed = raw.trim()
  if (trimmed.length > maxLength) {
    return { ok: false, response: apiError(`keyword は ${maxLength} 文字以内で指定してください`, 400) }
  }
  const keyword = trimmed || undefined
  return { ok: true, keyword }
}
