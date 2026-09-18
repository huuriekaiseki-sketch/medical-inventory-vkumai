import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'
import type { z } from 'zod'
import { apiError } from '@/lib/api-error'
import { firstIssueMessage } from '@/lib/validation/text-limits'

// WHY: issue #757 の 20。「スキーマを読み込んでいるか」を検査しても、読み込んだうえで
//      使っていない route は捕まえられない。**検知を賢くするより、間違えられる道を無くす。**
//      本文を読む方法をこの関数だけにし、`request.json()` の直接呼び出しは eslint で禁止する
//      （ログを log-safe.ts に、日付整形を format-date.ts に寄せたのと同じ形）。
//
//      これで検査は「禁止した書き方が無いか」だけになり、書き方を変えて抜けることができない。
//
// WHY(応答を返す): 検証に失敗したときの応答（400 と最初の 1 件のメッセージ）もここで作る。
//      route ごとに書くと文言と形がぶれる。

export type ParseBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<{ error: string }> }

/**
 * リクエスト本文を読んで検証する。**API Route が本文を読む唯一の方法。**
 *
 * 使い方:
 * ```ts
 * const parsed = await parseBody(request, consumableInputSchema)
 * if (!parsed.ok) return parsed.response
 * const body = parsed.data
 * ```
 */
export async function parseBody<T extends z.ZodType>(
  request: NextRequest,
  schema: T
): Promise<ParseBodyResult<z.infer<T>>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    // WHY: 本文が JSON でない・空のときは 400。中身は見せない（何を送ったかを鸚鵡返しにしない）
    return { ok: false, response: apiError('リクエストが不正です', 400) }
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, response: apiError(firstIssueMessage(parsed.error), 400) }
  }
  return { ok: true, data: parsed.data }
}
