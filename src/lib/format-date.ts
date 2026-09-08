// WHY: issue #757 の 15（時刻・タイムゾーン・日付跨ぎ）。DB の timestamptz は UTC、施設の運用は JST。
//      `new Date(iso).toLocaleDateString('ja-JP')` は**実行環境のタイムゾーン**で整形するので、
//      Vercel（UTC）でサーバー整形すると JST 0:00〜9:00 の出来事が前日の日付になる。
//      画面（ブラウザ）でも利用者の端末設定に依存する。この製品は日本の施設向けなので、
//      整形は必ず Asia/Tokyo に固定し、ここ以外で toLocale*String を呼ばない
//      （eslint no-restricted-syntax が src/ 全体で禁止し、このファイルだけを例外にする）。

const JST = 'Asia/Tokyo'

/** 日付だけ（例: 2026/6/27）。JST 固定 */
export function formatJstDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('ja-JP', { timeZone: JST })
}

/** 日付と時刻（例: 2026/6/27 0:05:00）。JST 固定。従来の toLocaleString('ja-JP') と同じ形 */
export function formatJstDateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: JST })
}

/** 2 桁固定の日付と時刻（例: 2026/06/27 00:05）。一覧の桁を揃える用途。JST 固定 */
export function formatJstDateTimeShort(iso: string | Date): string {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: JST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * `<input type="datetime-local">` の値を、JST の時刻として ISO 文字列に直す。
 *
 * WHY(2026-09-08 追加): `datetime-local` はタイムゾーンを持たない文字列
 *      （`2026-03-04T05:06`）を返す。そのまま送ると PostgreSQL の timestamptz は
 *      **サーバーのタイムゾーン（Supabase は UTC）として解釈**するので、
 *      利用者が 05:06 と入れた返却が `05:06+00:00` で保存され、
 *      一覧（Asia/Tokyo 固定で整形）では **14:06 と表示される**。
 *      E2E で実測して見つけた（入れた時刻と出てくる時刻が 9 時間ずれる）。
 *      この製品は日本の施設向けで、画面の入力も表示も JST なので、
 *      送る前にオフセットを明示して意味を確定させる。
 *
 * 限界: 直すのは**画面から送る値**だけ。API を直接叩く経路がタイムゾーン無しの文字列を
 *      送れば、これまでどおり UTC として保存される（入口の schema は形を見ていない）。
 */
export function jstLocalInputToIso(localValue: string): string {
  if (!localValue) return localValue
  // 既にオフセットや Z が付いている値には触らない（意味が決まっているものを書き換えない）
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(localValue)) return localValue
  // 秒あり（YYYY-MM-DDTHH:mm:ss）／秒なし（YYYY-MM-DDTHH:mm）の両方を受ける
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)
    ? `${localValue}:00`
    : localValue
  return `${withSeconds}+09:00`
}
