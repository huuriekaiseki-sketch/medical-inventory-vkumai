// ロット検索の画面（クライアント側）が使う入力の上限。
//
// WHY(設定を直接読まない、issue #814): 上限の出どころは aidd.config.json の limits.textLength.lot で、
//      API 側（lotSearchQuerySchema）はそこから読む。画面も同じ場所から読みたいが、クライアント側の
//      コードが設定の JSON を import すると、**設定が丸ごとブラウザ側の束に入る**。2026-09-20 に
//      build して実測した——設定にしか無い語（高リスクパスやドメイン語の一覧のキー）が、この画面と
//      同じ chunk に出た。Turbopack は JSON を使ったキーだけに削らない。
//      上限の数字 1 つのために、リポジトリの内部の語彙を利用者のブラウザへ配らない。
//
// WHY(それでも食い違わせない): ここに書いた値が設定と同じであることを
//      `__tests__/limits.test.ts` が固定する（DB の CHECK と設定を突合で揃えているのと同じ形）。
//      設定の値を変えたら、そのテストが落ちてここを直すことになる。
//      分ける前は画面が自前で 100 を持っており、どの検査にも掛かっていなかった
//      （check-text-length-consistency は zod の `.max(数字)` しか見ない）。
//
// このファイルに import を足さないこと（足したものはブラウザ側の束に入る）。

export const LOT_MIN_LENGTH = 1
export const LOT_MAX_LENGTH = 100
export const LOT_LENGTH_ERROR_MESSAGE = `${LOT_MIN_LENGTH}〜${LOT_MAX_LENGTH}字で入力してください`
