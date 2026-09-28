import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { logServerError } from '@/lib/log-safe'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=auth', request.url))
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    // WHY: 画面には一律「認証に失敗しました」しか出さない（拒否理由を外に出さない方針はそのまま）。
    //      その代わり内側で追えないと原因が一切分からない状態だったので、name / code / message を
    //      サーバー側ログに残す。最も多いのは、リンクを要求したブラウザと別のブラウザで開き、
    //      PKCE の code_verifier が cookie に無いケース（code: flow_state_not_found）。外部の利用者が
    //      最も踏みやすい離脱ポイントなので、理由を区別できるようにしておく。
    //      出口は log-safe（message は伏せ字、details / hint は捨てる）に揃え、console.* を直接呼ばない
    logServerError('auth_callback_exchange_failed', error)
    return NextResponse.redirect(new URL('/login?error=auth', request.url))
  }

  return NextResponse.redirect(new URL('/', request.url))
}
