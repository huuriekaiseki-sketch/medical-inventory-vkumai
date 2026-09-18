import { headers } from 'next/headers'
import { DENIAL_METHOD_HEADER, DENIAL_ROUTE_HEADER } from '@/lib/security/denial-headers'
import { logServerError } from '@/lib/log-safe'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'
import { createServiceRoleClientAccessor } from '@/lib/security/service-role-client'

// WHY: issue #757 の 24。拒否された操作は audit_log の行トリガーに来ないので、
//      アプリの認可ガードが弾いた瞬間にここで記録する（P-063）。
//      乗っ取りの兆候は「成功した操作」ではなく「失敗した操作の並び」に出るため、
//      誰が・いつ・どの境界で弾かれたかを残す。
//
// WHY(記録の失敗でリクエストを止めない): 記録は証跡であって拒否そのものではない。
//      DB が落ちていても「拒否する」動作は変わってはいけないので、ここでの例外は
//      すべて飲み込む（拒否は fail-closed のまま、記録だけが fail-open）。
//      docs/agents/fail-open-inventory.md の型。
//
// WHY(service_role): 書き込みは record_access_denial()（SECURITY DEFINER）だけが行い、
//      その EXECUTE は service_role にしか渡していない。client ロールから偽の記録を
//      作れないようにするため（#757-32 の量の問題も同じ理由で防ぐ）。
//
// 既知の限界（migration 20260907000002 にも同じことを書いてある）:
//   - proxy.ts が admin パスを /login へリダイレクトする経路の記録は `/login` の
//     Server Component（src/app/login/page.tsx）が proxy の付けた印（httpOnly cookie）を
//     読んで行う（#757-24）。印は偽造できるが、actor_id は `/login` 側がそのリクエストの
//     セッションから取るため、他人に濡れ衣を着せることはできない。MFA 未昇格の非 admin は
//     admin 判定より先に MFA ガードで /mfa-challenge へ送られるため、この経路は未記録
//   - RLS が黙って 0 件を返す拒否はアプリから見えない。ID 指定の 1 件取得（facilities /
//     hospital_prices）だけは hidden-row-denial.ts が service_role で存在を確かめて記録する
//     （2026-09-13、W-023）。一覧の空配列と PostgREST 直叩きは今も見えない
//   - route / method は proxy が転送リクエストへ付けたヘッダ、または `/login` が印から
//     直接渡した値から取る。どちらも通らない呼び出し（テスト・スクリプト）では null のまま

export type DenialGuard = 'auth' | 'facility' | 'admin' | 'proxy_admin' | 'rate_limit'
export type DenialReason =
  | 'unauthenticated'
  | 'facility_id_required'
  | 'forbidden'
  | 'not_admin'
  | 'rate_limited'
  // admin ではあるが aal2 へ昇格していない（W-011 の実行直前の再確認で弾いた分）。
  // DB 側の語彙は migration 20260907040000 で広げてある（片方だけだと CHECK 違反になる）
  | 'aal2_required'

export interface AccessDenial {
  guard: DenialGuard
  reason: DenialReason
  actorId?: string | null
  facilityId?: string | null
  /** 明示したいときだけ渡す。省略時は proxy が付けたヘッダから取る */
  route?: string | null
  method?: string | null
}

// WHY(共有ヘルパー、issue #793): クライアントの生成・キャッシュ・env 未設定時の初回警告は
//      4 ファイルに同じものがコピペされていた。service-role-client.ts へ一本化してある
//      （使い回す理由・警告が 1 回で済む理由・fail-open の境界もそちらの WHY に集約）。
const client = createServiceRoleClientAccessor('access_denial_client_unavailable')

// proxy が付けたヘッダから経路を取る。Route Handler の外（テスト・スクリプト）では
// headers() が使えないので、その場合は経路なしで記録する（記録自体は止めない）
async function routeFromHeaders(): Promise<{ route: string | null; method: string | null }> {
  try {
    const h = await headers()
    return { route: h.get(DENIAL_ROUTE_HEADER), method: h.get(DENIAL_METHOD_HEADER) }
  } catch {
    return { route: null, method: null }
  }
}

export async function recordAccessDenial(denial: AccessDenial): Promise<void> {
  try {
    const db = client.get()
    if (!db) return
    const ctx =
      denial.route !== undefined || denial.method !== undefined
        ? { route: denial.route ?? null, method: denial.method ?? null }
        : await routeFromHeaders()
    // WHY: 省略可の引数は undefined で渡す（SQL 側が DEFAULT NULL を持つ）。
    //      null を渡すと生成型（p_route?: string）と食い違う
    // WHY(error を受け取る): PostgREST の失敗は throw ではなく戻り値の error に来るので、
    //      捨てると try/catch にも来ず、**記録できていないことに誰も気づけない**
    //      （2026-09-07 のマージ後に check-fail-open.test.sh が捕まえた）。
    //      握りつぶすのは「拒否そのものを止めない」ためであって、黙ることではない。
    // WHY(#757-31、2026-09-08 の実測): 記録は判定そのものではないが、**拒否の道の途中にある**。
    //      PostgREST を止めて測ったら、判定に上限を付けた後も `requireFacilityAccess` が
    //      26.6 秒かかっていた（5 秒 + 5 秒 + **記録の待ち 約 16 秒**）。
    //      判定を切っても記録で待たされるなら、上限を付けた意味が無い。
    //      記録の失敗は元から握りつぶす設計なので、諦めても拒否の結果は変わらない。
    const { error } = await withJudgmentTimeout<{ error: unknown }>(
      'rpc.record_access_denial',
      () => db.rpc('record_access_denial', {
        p_guard: denial.guard,
        p_reason: denial.reason,
        p_route: ctx.route ?? undefined,
        p_method: ctx.method ?? undefined,
        p_actor_id: denial.actorId ?? undefined,
        p_facility_id: denial.facilityId ?? undefined,
      }),
      () => ({ error: null }),
    )
    if (error) logServerError('record_access_denial', error)
  } catch (error) {
    // WHY: 記録の失敗は握りつぶす（上のコメント参照）。ここで throw すると
    //      「記録できないと拒否できない」になり、可用性の穴になる。
    //      ただし想定外の例外は（プロセス再起動の前兆の可能性があるため）ログに残す
    //      （SPEC part 1、受け入れ条件3）
    logServerError('record_access_denial_unexpected', error)
  }
}
