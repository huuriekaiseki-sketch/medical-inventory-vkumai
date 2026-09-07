import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.generated'
import { recordAccessDenial } from '@/lib/security/access-denial'
import limitsConfig from '../../../aidd.config.json'

// WHY: issue #757 の 32（量の上限、quota-inventory の Q-002）。
//      2026-09-07 の点検で、同じ API を何回叩いても止まる仕組みが 1 つも無いことが分かった。
//      止めたいのは攻撃者ではなく「権限のある人が想定外の量を使う」場合で、守るのは
//      お金（外部サービスの従量課金）と可用性（他の利用者が使えなくなる）。
//
// WHY(値を設定から読む): 上限は人が決める値で、リポジトリごとに違う。ここに数字を書くと
//      次のリポジトリでも AI が既定値を置くことになるので、aidd.config.json の limits を読む。
//      未記入・置き換え忘れは scripts/check-design-answers.test.sh が止める。
//
// WHY(超えたら拒否して記録): 人の回答は「拒否して記録に残す」。黙って通すと上限が無いのと
//      同じで、黙って捨てると原因が分からない。429 を返し access_denials に 1 行残す。

const WINDOW_SECONDS = 60

/** 1 人あたり毎分の上限（人が決めた値。aidd.config.json の limits） */
export const REQUESTS_PER_MINUTE: number = limitsConfig.limits.requestsPerMinute

/** 管理者 1 人あたり 1 日の招待メール上限（人が決めた値） */
export const INVITES_PER_DAY: number = limitsConfig.limits.invitesPerDay

export interface RateLimitResult {
  allowed: boolean
  /** 今の窓で何回目か。数えられなかった場合は null */
  hitCount: number | null
  limit: number
  /** 窓が変わる時刻（ISO 文字列）。数えられなかった場合は null */
  resetAt: string | null
  /** 数えられなかった（DB に届かない・環境変数が無い）。true のときは allowed=true で通す */
  unmeasured: boolean
}

// WHY(使い回す): 拒否と同じ理由。1 リクエストごとに createClient すると内部の fetch 設定を
//      毎回組み立てることになり、実測で統合テストの所要時間が 3 倍になった（#757-24 のとき）。
let cached: ReturnType<typeof createClient<Database>> | null | undefined

function serviceRoleClient() {
  if (cached !== undefined) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  cached = url && key
    ? createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    : null
  return cached
}

/** テスト用。環境変数を差し替えたあとに呼ぶ */
export function resetRateLimitClientForTests(): void {
  cached = undefined
}

/**
 * 固定窓で 1 回数え、上限内かを返す。
 *
 * WHY(数えられないときは通す): 上限はお金と可用性のための仕組みであって認可ではない。
 *      DB に届かないときに全部の業務を止めると、上限の仕組みが可用性の穴になる。
 *      通した事実は unmeasured=true で呼び出し側に返す（fail-open-inventory に記載）。
 */
export async function consumeRateLimit(
  bucket: string,
  limit: number = REQUESTS_PER_MINUTE,
  windowSeconds: number = WINDOW_SECONDS
): Promise<RateLimitResult> {
  const unmeasured: RateLimitResult = { allowed: true, hitCount: null, limit, resetAt: null, unmeasured: true }
  try {
    const db = serviceRoleClient()
    if (!db) return unmeasured
    const { data, error } = await db.rpc('consume_rate_limit', {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
    if (error) return unmeasured
    const row = Array.isArray(data) ? data[0] : data
    if (!row) return unmeasured
    return {
      allowed: row.allowed,
      hitCount: row.hit_count,
      limit: row.limit_value,
      resetAt: row.reset_at,
      unmeasured: false,
    }
  } catch {
    return unmeasured
  }
}

/**
 * 1 人あたり毎分の上限を消費し、超えていれば拒否として記録する。
 * 呼び出し側は allowed=false のとき 429 を返す。
 */
export async function consumeUserRequestQuota(userId: string): Promise<RateLimitResult> {
  const result = await consumeRateLimit(`user:${userId}`)
  if (!result.allowed) {
    await recordAccessDenial({ guard: 'rate_limit', reason: 'rate_limited', actorId: userId })
  }
  return result
}

/**
 * 招待メールの 1 日あたりの上限を消費し、超えていれば拒否として記録する。
 * WHY: メールは外に出ていく唯一の経路で、従量課金と迷惑メール判定の対象（Q-020）。
 */
export async function consumeInviteQuota(adminUserId: string): Promise<RateLimitResult> {
  const result = await consumeRateLimit(`invite:${adminUserId}`, INVITES_PER_DAY, 24 * 60 * 60)
  if (!result.allowed) {
    await recordAccessDenial({ guard: 'rate_limit', reason: 'rate_limited', actorId: adminUserId })
  }
  return result
}
