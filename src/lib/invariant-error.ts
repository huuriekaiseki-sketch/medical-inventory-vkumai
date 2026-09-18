import { ClientVisibleError } from './client-visible-error'

// WHY: 業務不変条件（docs/agents/invariant-catalog.md）は DB の CHECK / トリガーが守り、
//      破ると PostgreSQL の check_violation（23514）になる。判定ロジックはアプリに持たず、
//      ここで利用者向けの一文に写像するだけにする（RPC 経由・直接 INSERT のどちらでも同じ文言）。
export const INVARIANT_VIOLATION_MESSAGE = '入力値が業務ルールに反しています（数量は 1 以上、金額は 0 以上、状態は戻せません）'

// WHY(2026-09-08 追加): 明細の JAN は `products.jan` への外部キー
//      （case_order_items / loan_order_items / loan_return_items の `*_jan_fkey`。
//      20260626000000 で追加、20260714000004 で VALIDATE 済み）。
//      **画面の JAN は自由入力で、API も存在を確かめていない**ので、製品マスタに無い JAN を
//      入れると 23503 になる。これを生のエラーのまま扱うと利用者には
//      500「返却に失敗しました」としか返らず、**何が悪いのか分からない**
//      （E2E で実測。短貸返却と症例発注は JAN が必須なので必ずこうなる）。
//      利用者の直せる間違いなので、400 と「未登録である」ことを伝える。
export const UNKNOWN_JAN_MESSAGE = '製品マスタに登録されていない JAN です'

export function isCheckViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23514'
}

type PostgresError = { code?: string; message: string; details?: string | null }

/** 明細の JAN → products.jan の外部キー違反か（3 つの明細表で制約名の形が同じ） */
function isUnknownJanViolation(error: PostgresError): boolean {
  return error.code === '23503' && /_jan_fkey/.test(error.message ?? '')
}

/**
 * PostgreSQL の DETAIL から、利用者が入れた JAN だけを取り出す。
 *
 * WHY(DETAIL をそのまま出さない): DETAIL は `Key (jan)=(...) is not present in table "products".`
 *      の形で、表名を含む。返してよいのは**利用者が自分で入力した値**だけなので、
 *      括弧の中だけを取り出す。取れなければ値を添えない（推測で埋めない）。
 */
function extractJan(details?: string | null): string | undefined {
  // WHY(空を先に返す・2026-09-08): 以前は `details ?? ''` を正規表現に渡していた。
  //      その空文字を別の文字列に変える変異が**どう変えても結果が同じ**（等価変異）で、
  //      殺せないまま残った。例外として登録するより、**渡さない形にして変異ごと無くす**。
  if (!details) return undefined
  const m = /Key \(jan\)=\(([^)]*)\)/.exec(details)
  return m?.[1]
}

/**
 * repository が受け取った DB エラーを、利用者に見せてよい形へ写す。
 * 該当しないものは生のメッセージのまま返す（route 側が伏せてログにだけ出す）。
 */
export function toRepositoryError(error: PostgresError): Error {
  if (isCheckViolation(error)) return new ClientVisibleError(INVARIANT_VIOLATION_MESSAGE)
  if (isUnknownJanViolation(error)) {
    const jan = extractJan(error.details)
    return new ClientVisibleError(
      jan
        ? `${UNKNOWN_JAN_MESSAGE}: ${jan}。先に製品マスタへ登録してください`
        : `${UNKNOWN_JAN_MESSAGE}。先に製品マスタへ登録してください`
    )
  }
  return new Error(error.message)
}
