import { headers } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.generated'
import { DENIAL_METHOD_HEADER, DENIAL_ROUTE_HEADER } from '@/lib/security/denial-headers'

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
//   - proxy.ts が admin パスを /login へリダイレクトする経路は、Edge Runtime に
//     service role を持ち込まないため未記録（guard='proxy_admin' は将来のために予約）
//   - RLS が黙って 0 件を返す拒否はアプリから見えない
//   - route / method は proxy が転送リクエストへ付けたヘッダから取る。proxy を通らない
//     呼び出し（テスト・スクリプト）では null のまま

export type DenialGuard = 'auth' | 'facility' | 'admin' | 'proxy_admin'
export type DenialReason = 'unauthenticated' | 'facility_id_required' | 'forbidden' | 'not_admin'

export interface AccessDenial {
  guard: DenialGuard
  reason: DenialReason
  actorId?: string | null
  facilityId?: string | null
  /** 明示したいときだけ渡す。省略時は proxy が付けたヘッダから取る */
  route?: string | null
  method?: string | null
}

// WHY(使い回す): 拒否は総当たり攻撃のときに連続で起きる。そのたびに createClient すると
//      内部の fetch 設定を毎回組み立てることになり、実測で統合テストの所要時間が 3 倍になった。
//      クライアントはセッションを持たない（persistSession: false）ので使い回して問題ない。
let cached: ReturnType<typeof createClient<Database>> | null | undefined

function serviceRoleClient() {
  if (cached !== undefined) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // 環境変数が無い実行環境（単体テスト等）では記録しない
  cached = url && key
    ? createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    : null
  return cached
}

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
    const db = serviceRoleClient()
    if (!db) return
    const ctx =
      denial.route !== undefined || denial.method !== undefined
        ? { route: denial.route ?? null, method: denial.method ?? null }
        : await routeFromHeaders()
    // WHY: 省略可の引数は undefined で渡す（SQL 側が DEFAULT NULL を持つ）。
    //      null を渡すと生成型（p_route?: string）と食い違う
    await db.rpc('record_access_denial', {
      p_guard: denial.guard,
      p_reason: denial.reason,
      p_route: ctx.route ?? undefined,
      p_method: ctx.method ?? undefined,
      p_actor_id: denial.actorId ?? undefined,
      p_facility_id: denial.facilityId ?? undefined,
    })
  } catch {
    // WHY: 記録の失敗は握りつぶす（上のコメント参照）。ここで throw すると
    //      「記録できないと拒否できない」になり、可用性の穴になる
  }
}
