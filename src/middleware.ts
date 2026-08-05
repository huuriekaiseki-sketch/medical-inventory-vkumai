// src/middleware.ts
// WHY: 全パスの認証ガード（未認証→/login）と admin ガード（/admin/*, /api/admin/*）を
//      middleware で一元化し、重複実装を避けるため。セッションリフレッシュも同時実行。
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

export async function middleware(request: NextRequest) {
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
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // 未認証ガード
  if (!user && !PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // MFAガード（aal1のまま保護ページへ進ませない）
  if (user && pathname !== MFA_CHALLENGE_PATH) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== aal.nextLevel) {
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
