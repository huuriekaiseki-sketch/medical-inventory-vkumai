// WHY: created_at は timestamptz(UTC)だが、日付入力は施設の運用時間帯(JST)基準。
//      UTC固定で扱うと日付境界が最大9時間ずれるため、+09:00を明示してJSTの一日として解釈する。
//      この変換ロジックが case-orders/consumable-orders/loan-orders/loan-returns/orders の
//      各repositoryに文字列テンプレートとして重複実装されていた（issue #20 レビュー指摘:
//      重複・過剰実装）ため、1箇所にまとめる

/** YYYY-MM-DD を JST 0:00 開始境界の ISO8601 文字列（gte用）に変換する */
export function jstDayStart(dateFrom: string): string {
  return `${dateFrom}T00:00:00+09:00`
}

/** YYYY-MM-DD を JST 23:59:59 終了境界の ISO8601 文字列（lte用）に変換する */
export function jstDayEnd(dateTo: string): string {
  return `${dateTo}T23:59:59+09:00`
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
