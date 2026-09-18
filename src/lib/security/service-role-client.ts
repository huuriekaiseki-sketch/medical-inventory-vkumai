import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.generated'
import { logServerError } from '@/lib/log-safe'

// WHY: issue #793。service_role のクライアントを作る同じ 12 行が 4 ファイルに**コピペ**されていた
//      （access-denial / hidden-row-denial / privileged-operation / rate-limit）。
//      しかも警告ログを持っていたのは access-denial.ts だけで、残り 3 ファイルは
//      **env が無いと黙って null を返し、記録がまるごと落ちていた**。
//      本番の設定漏れでも同じ経路を通るので、「監査記録が全部消えている」ことに誰も気づけない。
//
// WHY(使い回す): 拒否は総当たり攻撃のときに連続で起きる。そのたびに createClient すると
//      内部の fetch 設定を毎回組み立てることになり、実測で統合テストの所要時間が 3 倍になった
//      （#757-24 のとき）。クライアントはセッションを持たない（persistSession: false）ので
//      使い回して問題ない。
//
// WHY(呼び出し元ごとに独立したキャッシュ): プロセス全体で 1 つの Singleton にはしない。
//      そうすると「初回だけ警告」の粒度がプロセス全体になり、**先に呼ばれた側の logKey でしか
//      警告が出ない**——どの記録経路が死んでいるか分からなくなるうえ、テストが実行順で揺れる。
//      呼び出し元が増えても既存の生存期間に影響しないという利点もある。
//
// WHY(fail-open のまま): 記録は証跡であって拒否そのものではない。env が無ければ null を返し、
//      呼び出し元は記録せずに先へ進む（拒否は fail-closed のまま）。
//      変えたのは「黙って落ちる」ことだけで、落ちること自体は仕様。
//      docs/agents/fail-open-inventory.md の型。

export interface ServiceRoleClientAccessor {
  /** env が揃っていればクライアント、無ければ null（初回だけ警告ログを出す） */
  get(): ReturnType<typeof createClient<Database>> | null
  /** テスト用。環境変数を差し替えたあとに呼ぶと、次の get() で作り直す */
  resetForTests(): void
}

/**
 * service_role クライアントの取得口を作る。
 *
 * @param logKey env が揃っていないときに logServerError へ渡す識別子。
 *               **呼び出し元ごとに固有の値**を渡すこと（どの記録経路が死んだかを区別するため）。
 */
export function createServiceRoleClientAccessor(logKey: string): ServiceRoleClientAccessor {
  let cached: ReturnType<typeof createClient<Database>> | null | undefined

  return {
    get() {
      // WHY(警告が 1 回で済む理由): env が無いと cached は null で確定し、2 回目以降は
      //      この行で返るので、下の警告には**この取得口につき 1 回しか到達しない**。
      //      専用のフラグは要らない。この早期 return を消すと警告が毎回出るようになるが、
      //      それは「初回だけ警告ログが出る」テストが落として知らせる
      if (cached !== undefined) return cached
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      cached = url && key
        ? createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
        : null
      if (!cached) {
        logServerError(logKey, new Error('SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL is not set'))
      }
      return cached
    },

    resetForTests() {
      cached = undefined
    },
  }
}
