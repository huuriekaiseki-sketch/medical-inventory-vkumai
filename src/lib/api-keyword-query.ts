import { z } from 'zod'

// WHY: keyword クエリパラメータの長さ上限バリデーションを各 route.ts に重複実装させないための
//      共有部品（SPEC Set A）。
//
// WHY(2026-09-09、`URLSearchParams` を受け取る形をやめた): 以前は `parseKeyword(params)` という
//      **`URLSearchParams` を受け取る関数**で、route 側が `request.nextUrl.searchParams` を
//      取り出して渡していた。そのため「route は searchParams に触らない」を eslint で言えず、
//      クエリを読む唯一の入口（`parseQuery`）に穴が残っていた。
//      **形（shape）を配る**ようにして、ほかの項目と一緒に 1 つの `z.object` へ混ぜられるようにする。
//
// WHY(trim してから長さを見る): 前後の空白だけで上限を超える入力を不当に弾かないため
//      （レビュー指摘: 正しさ minor）。空白だけの入力は「指定なし」として扱う。
//
// WHY(文言を 1 つにした): 移行前は `/api/compat` だけ「キーワードは100文字以内で入力してください」で、
//      ほかは「keyword は 100 文字以内で指定してください」だった。同じ問いに 2 通りの答えがある状態
//      （E-053）なので、こちらへ揃えた（compat の文言はどのテストも見ていなかった）。

export const DEFAULT_KEYWORD_MAX_LENGTH = 100

/**
 * keyword クエリの形。ほかの項目と一緒に `z.object({ ...keywordQueryShape(), ... })` で使う。
 *
 * 受け取ったあとの値は「trim 済みの文字列」か `undefined`（未指定・空・空白のみ）。
 */
export const keywordQueryShape = (maxLength: number = DEFAULT_KEYWORD_MAX_LENGTH) =>
  ({
    keyword: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined)
      .refine((value) => value === undefined || value.length <= maxLength, {
        error: `keyword は ${maxLength} 文字以内で指定してください`,
      }),
  }) as const
