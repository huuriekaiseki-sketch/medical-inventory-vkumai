import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.generated'

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
//   - route / method は proxy がヘッダを付ける段（次の PR）まで null

export type DenialGuard = 'auth' | 'facility' | 'admin' | 'proxy_admin'
export type DenialReason = 'unauthenticated' | 'facility_id_required' | 'forbidden' | 'not_admin'

export interface AccessDenial {
  guard: DenialGuard
  reason: DenialReason
  actorId?: string | null
  facilityId?: string | null
  /** 経路が分かる呼び出し元だけが渡す（現状は未使用。列は先に用意してある） */
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

export async function recordAccessDenial(denial: AccessDenial): Promise<void> {
  try {
    const db = serviceRoleClient()
    if (!db) return
    // WHY: 省略可の引数は undefined で渡す（SQL 側が DEFAULT NULL を持つ）。
    //      null を渡すと生成型（p_route?: string）と食い違う
    await db.rpc('record_access_denial', {
      p_guard: denial.guard,
      p_reason: denial.reason,
      p_route: denial.route ?? undefined,
      p_method: denial.method ?? undefined,
      p_actor_id: denial.actorId ?? undefined,
      p_facility_id: denial.facilityId ?? undefined,
    })
  } catch {
    // WHY: 記録の失敗は握りつぶす（上のコメント参照）。ここで throw すると
    //      「記録できないと拒否できない」になり、可用性の穴になる
  }
}
