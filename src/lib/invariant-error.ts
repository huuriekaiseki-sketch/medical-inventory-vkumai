import { ClientVisibleError } from './client-visible-error'

// WHY: 業務不変条件（docs/agents/invariant-catalog.md）は DB の CHECK / トリガーが守り、
//      破ると PostgreSQL の check_violation（23514）になる。判定ロジックはアプリに持たず、
//      ここで利用者向けの一文に写像するだけにする（RPC 経由・直接 INSERT のどちらでも同じ文言）。
export const INVARIANT_VIOLATION_MESSAGE = '入力値が業務ルールに反しています（数量は 1 以上、金額は 0 以上、状態は戻せません）'

export function isCheckViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23514'
}

/** 23514 なら利用者向けメッセージの ClientVisibleError、それ以外は生のメッセージの Error を返す */
export function toRepositoryError(error: { code?: string; message: string }): Error {
  return isCheckViolation(error) ? new ClientVisibleError(INVARIANT_VIOLATION_MESSAGE) : new Error(error.message)
}
