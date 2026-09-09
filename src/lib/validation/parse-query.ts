import type { NextRequest, NextResponse } from 'next/server'
import type { z } from 'zod'
import { apiError } from '@/lib/api-error'
import { firstIssueMessage } from '@/lib/validation/text-limits'

// WHY(2026-09-09、#757 の 20 の続き): 本文（body）は `parseBody` という**唯一の入口**へ寄せ、
//      `request.json()` の直接呼び出しを eslint で禁止して閉じた。
//      **クエリ文字列にはそれが無かった。** 実測すると **13 route が 30 か所**で
//      `searchParams.get()` を生読みし、検証はそれぞれの route で手書きだった
//      （数えているのは `.get(` の**呼び出し箇所**。最初は「引数の名前の種類」で数えて
//        12 route / 29 か所と書いてしまった——数える単位が違うと数字が合わない。C-031）。
//
//      手書きが分散すると、同じ問いの答えが場所ごとに食い違う。実際に食い違っていた:
//
//        | | api-pagination.ts | /api/news の独自実装 |
//        | 小数 | Number.isInteger で拒否 | Number.isFinite なので 1.5 が通る |
//        | 0    | limit < 1 で拒否        | < 0 なので 0 が通る |
//
//      これは E-053（同じ問いの答えが 2 か所にあって食い違う）そのもので、
//      RPC の参照先で同じ日に踏んだ形（手書きの分散）と同じ。
//      **検知を賢くするより、間違えられる道を無くす。**
//
// WHY(同じ鍵が複数回来たら拒否する): `?limit=1&limit=999` のような重複は、
//      `get()` が先頭だけを返すため**書き手が気づかないまま**片方が捨てられる。
//      層ごとに「先頭を採る／末尾を採る」が違うと、境界の検査をすり抜ける道になりうる
//      （パラメータ汚染）。ここでは**受け取らない**（fail-closed。C-021）。
//
// WHY(スキーマ側で coerce する): クエリ文字列の値は必ず文字列なので、
//      数値・真偽値はスキーマで `z.coerce` を使う。route 側で Number() を書かない。

export type ParseQueryResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<{ error: string }> }

/**
 * クエリ文字列を読んで検証する。**API Route がクエリ文字列を読む唯一の方法。**
 *
 * 使い方:
 * ```ts
 * const parsed = parseQuery(request, newsQuerySchema)
 * if (!parsed.ok) return parsed.response
 * const { facilityId, limit, offset } = parsed.data
 * ```
 */
export function parseQuery<T extends z.ZodType>(
  request: NextRequest,
  schema: T
): ParseQueryResult<z.infer<T>> {
  const params = request.nextUrl.searchParams
  const raw: Record<string, string> = {}

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    if (values.length > 1) {
      return {
        ok: false,
        response: apiError(`${key} は 1 つだけ指定してください`, 400),
      }
    }
    raw[key] = values[0]
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, response: apiError(firstIssueMessage(parsed.error), 400) }
  }
  return { ok: true, data: parsed.data }
}
