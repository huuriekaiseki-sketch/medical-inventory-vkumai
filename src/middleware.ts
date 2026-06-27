// src/middleware.ts
// WHY: /api/* への未認証アクセスを middleware で一元ブロックし、
//      各 route.ts に認証チェックを重複実装しないようにするため。

import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

// WHY: 認証機能実装前の暫定措置。全APIを認証なしで通過させる。
export async function middleware(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}
