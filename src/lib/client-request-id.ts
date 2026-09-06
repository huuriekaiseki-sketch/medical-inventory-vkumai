// WHY: 発注・返却の二重送信対策（issue #757 の 2、P-053）。画面はフォームを開いたときに 1 回だけ
//      UUID を作って送り、DB が「施設 × clientRequestId は 1 行」を UNIQUE で守る。同じ鍵の再送は
//      RPC が既存の行を返す。route はここで形だけを検査し、業務判定は持たない。
//      サーバー側で UUID を生成しても意味が無い（再送のたびに新しい鍵になる）ので、生成は画面の責務。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CLIENT_REQUEST_ID_INVALID_MESSAGE = 'clientRequestId は UUID で指定してください'

export function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * body.clientRequestId を検査する。未指定は許す（従来どおり毎回新しい行を作る）。
 * 指定があって UUID でなければエラー文言を返す。
 */
export function validateClientRequestId(value: unknown): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true }
  if (!isClientRequestId(value)) return { ok: false, message: CLIENT_REQUEST_ID_INVALID_MESSAGE }
  return { ok: true, value }
}
