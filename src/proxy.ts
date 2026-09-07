// src/proxy.ts
// WHY: 全パスの認証ガード（未認証→/login）と admin ガード（/admin/*, /api/admin/*）を
//      proxy（旧middleware。Next.js 16でファイル規約がproxyへ改名、issue #681）で
//      一元化し、重複実装を避けるため。セッションリフレッシュも同時実行。
//      admin判定はresolveIsAdmin()（src/lib/admin-status.ts）に一本化する。
//      SECURITY DEFINER RPC(get_admin_status)を使うため、Edge Runtimeでも
//      service role keyなしにセッション付きクライアントでDB roleベース判定＋
//      ADMIN_EMAILSフォールバックの両方が可能になる。

import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { resolveIsAdmin } from '@/lib/admin-status'

const PUBLIC_PATHS = ['/login', '/auth/callback']

// WHY: MFA(TOTP)を有効化したユーザーがaal1(パスワード/メールリンクのみ)の
// セッションのまま保護ページへアクセスするのを防ぐ。nextLevelがaal2で
// currentLevelと異なる間は/mfa-challenge以外へのアクセスを許さない。
const MFA_CHALLENGE_PATH = '/mfa-challenge'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // トークンリフレッシュ（updateSession パターン）
  // WHY: error は user null と同じ扱い（未認証として /login へ）。error を捨てても挙動は同じだが、
  //      「認可の判定材料はエラーを受け取る」規約（scripts/check-fail-open.test.sh）に揃える
  const { data: userData, error: userError } = await supabase.auth.getUser()
  const user = userError ? null : userData.user

  const pathname = request.nextUrl.pathname

  // 未認証ガード
  if (!user && !PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // MFAガード（aal1のまま保護ページへ進ませない）
  if (user && pathname !== MFA_CHALLENGE_PATH) {
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    // WHY(issue #757 の 31、fail-open の総点検): 以前は error を捨て、aal が取れなければガードを
    //      素通りさせていた。Supabase Auth の MFA API が落ちている間、MFA 登録済み利用者の aal1
    //      セッションが保護ページを読めてしまう（DB は書き込みだけ aal2 を要求するので、読みは
    //      RLS で止まらない）。判定材料が取れないときは「昇格が要る」側に倒し、/mfa-challenge へ
    //      送る（同ページは MFA API のエラーを利用者に表示し、データは出さない）。
    //      docs/agents/fail-open-inventory.md の F-004
    if (aalError || !aal) {
      return NextResponse.redirect(new URL(MFA_CHALLENGE_PATH, request.url))
    }
    if (aal.nextLevel === 'aal2' && aal.currentLevel !== aal.nextLevel) {
      return NextResponse.redirect(new URL(MFA_CHALLENGE_PATH, request.url))
    }
  }

  // admin ガード（middleware + 各 route で二重チェック）
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/api/admin' || pathname.startsWith('/api/admin/')
  if (isAdminPath) {
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    // WHY: resolveIsAdminはSupabaseClient(rpc呼び出し)+fetchのみに依存するため
    //      Edge RuntimeのmiddlewareでもService Role Keyなしに動作する。
    const isAdmin = await resolveIsAdmin(supabase, user)

    if (!isAdmin) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    return supabaseResponse
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
