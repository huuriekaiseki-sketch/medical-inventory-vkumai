// src/middleware.ts
// WHY: 全パスの認証ガード（未認証→/login）と admin ガード（/admin/*, /api/admin/*）を
//      middleware で一元化し、重複実装を避けるため。セッションリフレッシュも同時実行。
//      admin判定はDB roleベース（user_facilities.role='admin'）に統一し、
//      ADMIN_EMAILSはDBにadminが0件の場合のフォールバックとして使用する。

import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/auth/callback']

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

  // admin ガード（middleware + 各 route で二重チェック）
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/api/admin' || pathname.startsWith('/api/admin/')
  if (isAdminPath) {
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    // WHY: middlewareではcreateAdminSupabase（Service Role Key）が使えないため、
    //      ユーザーセッション付きのsupabaseクライアントでuser_facilitiesを問い合わせる。
    //      RLSにより自分の行のみ返るため、role='admin'チェックが可能。
    const { data: userAdminRows } = await supabase
      .from('user_facilities')
      .select('user_id, role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .limit(1)

    const isDbAdmin = userAdminRows && userAdminRows.length > 0

    if (!isDbAdmin) {
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
