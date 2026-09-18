import { z } from 'zod'

// WHY: created_at は timestamptz(UTC)だが、日付入力は施設の運用時間帯(JST)基準。
//      UTC固定で扱うと日付境界が最大9時間ずれるため、+09:00を明示してJSTの一日として解釈する。
//      この変換ロジックが case-orders/consumable-orders/loan-orders/loan-returns/orders の
//      各repositoryに文字列テンプレートとして重複実装されていた（issue #20 レビュー指摘:
//      重複・過剰実装）ため、1箇所にまとめる

/** YYYY-MM-DD を JST 0:00 開始境界の ISO8601 文字列（gte用）に変換する */
export function jstDayStart(dateFrom: string): string {
  return `${dateFrom}T00:00:00+09:00`
}

/**
 * YYYY-MM-DD を JST のその日の最後の瞬間（lte用）に変換する。
 * WHY(.999999): timestamptz はマイクロ秒精度。23:59:59 ちょうどで切ると 23:59:59.5 に作られた行が
 *      「その日」から漏れる（issue #757 の 15）。翌日 0:00 の lt に変えるのが本筋だが、
 *      5 つのリポジトリの .lte() を触らずに済むよう境界値だけを正す
 */
export function jstDayEnd(dateTo: string): string {
  return `${dateTo}T23:59:59.999999+09:00`
}

// WHY: jstDayStart/jstDayEnd は入力を検証せず文字列テンプレートで結合するだけのため、
//      date_from=abc のような不正値がそのままSupabaseクエリに渡り、400ではなく
//      PostgreSQLのクエリエラー（500）として露出していた（issue #20 レビュー指摘:
//      型安全・データ層の整合 important）。API境界（route.ts）で使う形式検証をここに置く。
const DATE_STRING_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** "YYYY-MM-DD" 形式かつ実在する暦日かを検証する（date_from/date_toのAPI入力検証用） */
export function isValidDateString(value: string): boolean {
  if (!DATE_STRING_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// WHY(2026-09-09、判定を 1 か所にする): `date_from` / `date_to` の検証が
//      `/api/admin/audit` と `/api/admin/reports` に**同じ 3 つの条件・同じ文言で 2 回**書かれていた。
//      いまは食い違っていないが、片方だけ直せば食い違う形（E-053 の予備軍）。
//      クエリ文字列の唯一の入口（`parseQuery`）へ移すのに合わせて、判定もここへ寄せる。

/** 日付範囲のクエリの形。ほかの項目と一緒に `z.object({ ...dateRangeShape, ... })` で使う */
export const dateRangeShape = {
  date_from: z.string().optional(),
  date_to: z.string().optional(),
} as const

/**
 * 日付範囲の中身を検査する。`dateRangeShape` を含む `z.object` に掛ける。
 *
 * WHY(else-if で順に見る): `parseQuery` は**最初の 1 件**を利用者に返す。
 *      形式の誤りと前後関係の誤りを同時に出すと、どれを直せばよいか分からなくなるので、
 *      移す前の route と同じ優先順（date_from の形式 → date_to の形式 → 前後関係）を保つ。
 */
export function refineDateRange<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const { date_from: from, date_to: to } = value as { date_from?: string; date_to?: string }
    if (from && !isValidDateString(from)) {
      ctx.addIssue({ code: 'custom', message: 'date_from は YYYY-MM-DD 形式で指定してください' })
    } else if (to && !isValidDateString(to)) {
      ctx.addIssue({ code: 'custom', message: 'date_to は YYYY-MM-DD 形式で指定してください' })
    } else if (from && to && from > to) {
      ctx.addIssue({ code: 'custom', message: 'date_from は date_to 以前の日付を指定してください' })
    }
  })
}
