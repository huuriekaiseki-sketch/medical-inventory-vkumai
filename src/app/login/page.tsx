import { headers } from 'next/headers'
import LoginForm from './LoginForm'
import { DENIAL_PAYLOAD_HEADER, parseProxyDenial } from '@/lib/security/denial-headers'
import { recordAccessDenial } from '@/lib/security/access-denial'
import { createServerSupabase } from '@/lib/supabase/server'
import { logServerError } from '@/lib/log-safe'

// WHY(#757-24): /login を Server Component（記録用の薄い皮）＋ Client Component（LoginForm、
//      ロジック無変更）に分割した。proxy が admin ガードで /login へ跳ね返す際に載せる
//      httpOnly cookie（印）の中身を、proxy が転送リクエストのヘッダ（DENIAL_PAYLOAD_HEADER）に
//      載せ替えたものをここで読み、access_denials に 1 行残す。
//
// WHY(cookie を直接読まない): proxy は /login の応答で印の cookie を消すが、Next.js はその削除を
//      同じリクエストの cookies() にも反映する。cookie を読むと常に空になり記録が 0 件になる
//      （2026-09-13 の E2E で発覚。単体テストはモックで通っていた）。ヘッダは proxy が必ず
//      上書き・削除するので、クライアントは偽装できない
//
// WHY(runtime を指定しない): access-denial.ts の serviceRoleClient() は
//      SUPABASE_SERVICE_ROLE_KEY の有無だけを見る。Edge には持ち込めないので Node 既定のまま。
//
// WHY(fail-open を3層に分ける): 記録は付随情報であり、/login の表示を止めてはいけない。
//      cookies() 自体の例外・印の parse 失敗・getUser() の失敗・recordAccessDenial の例外を
//      それぞれ別の try/catch で捕まえ、logServerError に区別できる理由を残す
//      （docs/agents/fail-open-inventory.md F-005）
export default async function LoginPage() {
  await recordProxyAdminDenialIfPresent()
  return <LoginForm />
}

async function recordProxyAdminDenialIfPresent(): Promise<void> {
  let raw: string | undefined
  try {
    const h = await headers()
    raw = h.get(DENIAL_PAYLOAD_HEADER) ?? undefined
  } catch (error) {
    logServerError('proxy_admin_denial_skip:header_unreadable', error)
    return
  }

  if (!raw) return

  let payload: ReturnType<typeof parseProxyDenial>
  try {
    payload = parseProxyDenial(raw)
  } catch (error) {
    logServerError('proxy_admin_denial_skip:payload_invalid', error)
    return
  }
  if (!payload) return

  let actorId: string | undefined
  if (payload.reason === 'not_admin') {
    try {
      const supabase = await createServerSupabase()
      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      actorId = data.user?.id
    } catch (error) {
      logServerError('proxy_admin_denial_skip:session_unavailable', error)
      return
    }
  }

  try {
    await recordAccessDenial({
      guard: 'proxy_admin',
      reason: payload.reason,
      route: payload.route,
      method: payload.method,
      actorId,
    })
  } catch (error) {
    // WHY: recordAccessDenial は内部で握りつぶす設計だが、ここでの追加の catch は保険。
    //      内部で想定外の例外が起きた場合はログに残す（SPEC part 1、受け入れ条件4）
    logServerError('proxy_admin_denial_record_failed', error)
  }
}
