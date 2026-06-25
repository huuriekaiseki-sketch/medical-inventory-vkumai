// src/middleware.ts
// WHY: /api/* への未認証アクセスを middleware で一元ブロックし、
//      各 route.ts に認証チェックを重複実装しないようにするため。

import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // WHY: @supabase/ssr の createServerClient は Cookie の読み書きを
  //      request/response 経由で行う設計のため、ここで明示的に渡す。
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )

  // WHY: getSession() はローカル Cookie を信頼するだけで JWT 再検証を行わない。
  //      getUser() はサーバーサイドで Supabase に問い合わせるため改ざんトークンを防げる。
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return response
}

export const config = {
  matcher: ['/api/:path*'],
}
