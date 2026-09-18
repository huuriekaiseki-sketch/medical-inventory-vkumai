import { headers } from 'next/headers'
import { DENIAL_METHOD_HEADER, DENIAL_ROUTE_HEADER } from '@/lib/security/denial-headers'
import { logServerError } from '@/lib/log-safe'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'
import { createServiceRoleClientAccessor } from '@/lib/security/service-role-client'

// WHY: issue #757 の 24・39。特権書き込みルールブック W-011 の限界のうち
//      「auth.users の作成・削除が監査ログに残らない」を塞ぐ。
//
//      2026-09-07 の点検で、admin の利用者招待・削除は**成功しても何も記録されていなかった**。
//      弾かれた分だけが access_denials に残り、通った分は 1 件も残らない非対称な状態で、
//      「誰がいつ利用者を招待・削除したか」がアプリ側から追えなかった。
//      監査トリガーは public スキーマの行変更にしか付かず、GoTrue が持つ auth.users には届かない。
//
// WHY(記録の失敗で操作を止めない): access-denial.ts と同じ型。記録は証跡であって操作そのものではない。
//      ただし**黙って落とさない**（PostgREST の失敗は throw ではなく戻り値の error に来るので、
//      捨てると try/catch にも来ない。2026-09-07 に access-denial.ts で実際に起きた形）。
//
// WHY(メールをログに出さない): target_email は PII。DB には残す（誰に招待を送ったかを追うため。
//      2026-09-07 に人が決めた）が、`logServerError` の伏せ字がメールを [email] にするので
//      サーバーログには出ない。**DB には残るがログには出ない**、という分け方。
//
// 既知の限界:
//   - **Auth API の呼び出しと記録は 1 つのトランザクションに入らない。**
//     Auth は SQL の外なので「Auth は成功したが記録は失敗した」が起こりうる（W-011 と同型）。
//   - **Studio や service role キーを直に使った操作はここに来ない。** 記録するのはこの route を
//     通った分だけ（blast-radius の B-010 と同じ範囲）。
//   - MFA の登録・解除、パスワード再設定はこの route を通らないので対象外。

/** 記録する操作の語彙。DB の CHECK と揃える（片方だけ広げると CHECK 違反で記録だけが落ちる） */
export type PrivilegedOperation = 'user_invite' | 'user_delete'

export interface PrivilegedOperationRecord {
  operation: PrivilegedOperation
  succeeded: boolean
  /** 実行した admin */
  actorId: string
  /** 招待の相手（まだ利用者 ID が無いのでメールで残す） */
  targetEmail?: string | null
  /** 削除の相手 */
  targetUserId?: string | null
  /** 失敗したときの code（本文は入れない） */
  errorCode?: string | null
}

/** DB 側の CHECK（error_code は 100 文字まで）。超えると記録だけが静かに落ちる */
const ERROR_CODE_MAX = 100

/**
 * 失敗の理由を 1 語で残す。
 *
 * WHY(M-021 の実測、2026-09-07): ローカルの SMTP を止めて招待すると GoTrue は
 *      status 500 / message "Error sending invite email" を返すが、**`code` は付かない**。
 *      `error.code` だけを見ていると記録には「失敗」としか残らず、
 *      「メールが出せなかった」のか「既に登録済み（email_exists）」なのかが後から区別できない。
 *      code が無いときは HTTP の状態を代わりに残す。本文は入れない（PII が混ざりうるため）。
 */
export function toOperationErrorCode(error: { code?: string; status?: number } | null | undefined): string | null {
  if (!error) return null
  const code = error.code ?? (typeof error.status === 'number' ? `http_${error.status}` : 'unknown')
  return code.slice(0, ERROR_CODE_MAX)
}

// WHY(共有ヘルパー、issue #793): ここも 2026-09-19 まで**env 未設定時に黙って null を返して**
//      いた。特権操作（招待・削除）の記録が、設定漏れのときは痕跡を残さず消えていた。
//      同じコピペが 4 ファイルにあったので service-role-client.ts へ一本化した。
//
const client = createServiceRoleClientAccessor('privileged_operation_client_unavailable')

// WHY(この reset は残す、issue #793): 2026-09-19 の調査は「呼び出し元ゼロのデッドコード」と
//      判定したが、**それは `grep ... src` の結果で、`supabase/__tests__/` を見ていなかった**。
//      実際には privileged-operations-rls-idor.integration.test.ts:272,279 が呼んでいる。
//      あちらは単体テストと違い `vi.resetModules()` を使わず `import()` するので、
//      env を差し替えたあとキャッシュを捨てる口がここに無いと測れない。
//      **走査範囲を src に絞ったせいの誤判定**（C-040）で、型検査が捕まえた。
export function resetPrivilegedOperationClientForTests(): void {
  client.resetForTests()
}

async function routeFromHeaders(): Promise<{ route: string | null; method: string | null }> {
  try {
    const h = await headers()
    return { route: h.get(DENIAL_ROUTE_HEADER), method: h.get(DENIAL_METHOD_HEADER) }
  } catch {
    return { route: null, method: null }
  }
}

/** 特権操作の記録。成功・失敗の両方を残す（失敗だけだと乗っ取り後の被害範囲が分からない） */
export async function recordPrivilegedOperation(record: PrivilegedOperationRecord): Promise<void> {
  try {
    const db = client.get()
    if (!db) return
    const ctx = await routeFromHeaders()
    // WHY(#757-31): access-denial.ts と同じ。記録は特権操作の道の途中にあるので、
    //      ここで待つと admin の画面が固まる。記録の失敗は元から握りつぶす設計
    const { error } = await withJudgmentTimeout<{ error: unknown }>(
      'rpc.record_privileged_operation',
      () => db.rpc('record_privileged_operation', {
        p_operation: record.operation,
        p_succeeded: record.succeeded,
        p_actor_id: record.actorId,
        p_target_email: record.targetEmail ?? undefined,
        p_target_user_id: record.targetUserId ?? undefined,
        p_error_code: record.errorCode ?? undefined,
        p_route: ctx.route ?? undefined,
        p_method: ctx.method ?? undefined,
      }),
      () => ({ error: null }),
    )
    if (error) logServerError('record_privileged_operation', error)
  } catch (error) {
    // 記録の失敗で特権操作そのものを止めない。ただし黙らない
    logServerError('record_privileged_operation', error)
  }
}
