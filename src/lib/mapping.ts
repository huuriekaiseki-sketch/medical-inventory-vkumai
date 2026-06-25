/**
 * Supabase の行データ（型不定の unknown）を安全に変換する型ガード群。
 * as string / as number キャストの代わりに使い、null/型不一致でも壊れない値を返す。
 */

/** 文字列なら返し、それ以外は空文字。NOT NULL カラム向け。 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 文字列なら返し、それ以外は undefined。nullable な optional カラム向け。 */
export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 文字列なら返し、それ以外は null。nullable カラム向け。 */
export function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 数値に変換し、NaN なら 0。NOT NULL の数値カラム向け。 */
export function asNumber(value: unknown): number {
  const n = Number(value)
  return Number.isNaN(n) ? 0 : n
}

/** null/undefined はそのまま null、数値化して NaN なら null。nullable な数値カラム向け。 */
export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}
