// WHY: issue #757 の 5（PII のログ流出検査）。サーバー側のログ（Vercel の関数ログ）は施設の外に
//      出る場所であり、患者 ID・イニシャル・医師名・メールアドレスを載せてはいけない。
//      ところが PostgreSQL のエラーはそのままだと行の中身を含む:
//        - CHECK / NOT NULL 違反の DETAIL: "Failing row contains (id, facility, ..., PT-1234, T.K., 山田医師, ...)"
//        - UNIQUE 違反の DETAIL:          "Key (jan)=(4901234567890) already exists."
//      PostgREST はこれを error.details に載せ、console.error(error) で丸ごとログに出ていた。
//      ここで「ログに出してよい形」に落としてから出す。判定は保守的（疑わしい部分は伏せる）。
//
//      強制: eslint の no-console（eslint.config.mjs）でサーバー側コードの console.* を禁止し、
//      このファイルだけを例外にする。ログはすべて logServerError を通る。

const REDACTED = '[redacted]'

/** メッセージ本文に混ざりうる「行の中身」「キーの値」「メールアドレス」を伏せる */
export function scrubLogText(text: string): string {
  return text
    // PostgreSQL: DETAIL: Failing row contains (a, b, c).
    .replace(/Failing row contains \([^)]*\)/g, `Failing row contains (${REDACTED})`)
    // PostgreSQL: DETAIL: Key (col)=(value) already exists. / is not present in table
    .replace(/Key \(([^)]*)\)=\([^)]*\)/g, `Key ($1)=(${REDACTED})`)
    // メールアドレス
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
}

export type SafeLogRecord = {
  name: string
  code?: string
  message: string
  /** details / hint を持っていたか（中身は出さない。デバッグ時は DB 側のログで見る） */
  hadDetails: boolean
}

/**
 * ログに出してよい形に落とす。details / hint は捨て、message は伏せ字にする。
 * PostgREST のエラー（{ code, message, details, hint }）も Error も文字列も受ける。
 */
export function redactForLog(error: unknown): SafeLogRecord {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; details?: unknown; hint?: unknown }
    return {
      name: error.name,
      code: typeof withCode.code === 'string' ? withCode.code : undefined,
      message: scrubLogText(error.message),
      hadDetails: withCode.details != null || withCode.hint != null,
    }
  }
  if (error && typeof error === 'object') {
    const o = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown; name?: unknown }
    return {
      name: typeof o.name === 'string' ? o.name : 'Object',
      code: typeof o.code === 'string' ? o.code : undefined,
      message: scrubLogText(typeof o.message === 'string' ? o.message : ''),
      hadDetails: o.details != null || o.hint != null,
    }
  }
  return { name: typeof error, message: scrubLogText(String(error)), hadDetails: false }
}

/** サーバー側の唯一のエラーログ出口。context は「どこで」の短い固定文字列（利用者入力を入れない） */
export function logServerError(context: string, error: unknown): SafeLogRecord {
  const record = redactForLog(error)
  // ここがサーバー側ログの唯一の出口（eslint.config.mjs がこのファイルだけ no-console を外している）
  console.error(`[${context}]`, record)
  return record
}
