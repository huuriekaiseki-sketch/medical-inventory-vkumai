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
