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
import {
  DENIAL_COOKIE_NAME,
  DENIAL_METHOD_HEADER,
  DENIAL_PAYLOAD_HEADER,
  DENIAL_ROUTE_HEADER,
  encodeProxyDenial,
} from '@/lib/security/denial-headers'
import { buildCsp, generateNonce } from '@/lib/security/csp'

export const CSP_HEADER = 'Content-Security-Policy'
/** Next.js がレンダリング時に読む nonce の受け渡し口（ドキュメント既定の名前） */
export const NONCE_HEADER = 'x-nonce'

const PUBLIC_PATHS = ['/login', '/auth/callback']

// WHY: MFA(TOTP)を有効化したユーザーがaal1(パスワード/メールリンクのみ)の
// セッションのまま保護ページへアクセスするのを防ぐ。nextLevelがaal2で
// currentLevelと異なる間は/mfa-challenge以外へのアクセスを許さない。
const MFA_CHALLENGE_PATH = '/mfa-challenge'

// WHY(#757-24): Route Handler は自分のパスとメソッドを知る手段を持たないので、拒否の記録
//      （access_denials）に経路を残すには proxy が転送リクエストへ付けるしかない。
//      クライアントが同じ名前で送ってきても必ず上書きし、証跡に偽の経路を書かせない。
//      cookie を差し替えた後の request から作るので、Supabase の セッション更新とも両立する。
function forwardedHeaders(request: NextRequest, csp: Csp): Headers {
  const headers = new Headers(request.headers)
  headers.set(DENIAL_ROUTE_HEADER, request.nextUrl.pathname)
  headers.set(DENIAL_METHOD_HEADER, request.method)
  // WHY(#757-16): Next.js は**転送リクエストの** Content-Security-Policy を読んで nonce を取り出し、
  //      フレームワークのスクリプトに自動で付ける（node_modules/next/dist/docs/01-app/02-guides/
  //      content-security-policy.md）。応答側だけに付けても nonce はタグに載らないので、
  //      両方に同じ値を載せる。x-nonce は Server Component が headers() で読むための口。
  headers.set(NONCE_HEADER, csp.nonce)
  headers.set(CSP_HEADER, csp.value)
  // WHY(#757-24): /login に印（cookie）が付いて来たときだけ、その中身をヘッダで Server Component へ
  //      渡す。応答で cookie を消すと Next.js が同じリクエストの cookies() にも削除を反映するので、
  //      cookie を直接読ませると記録が 0 件になる（E2E で発覚）。クライアントが同名ヘッダを
  //      送ってきても、ここで必ず上書きするか削除する（印の cookie 自体の偽造は既知の限界）
  const denial = request.nextUrl.pathname === '/login'
    ? request.cookies.get(DENIAL_COOKIE_NAME)?.value
    : undefined
  if (denial) {
    headers.set(DENIAL_PAYLOAD_HEADER, denial)
  } else {
    headers.delete(DENIAL_PAYLOAD_HEADER)
  }
  return headers
}

// WHY(#757-24): admin パスへの未認可アクセスを /login へ跳ね返す際、「誰が・いつ・どの画面で
//      弾かれたか」を access_denials に残すための印を httpOnly cookie で載せる。
//      Route Handler は動かない（proxy が redirect で止めるため）ので、記録は /login の
//      Server Component が行う。cookie を付ける処理自体が失敗しても redirect は返す
//      （fail-open の層 1。docs/agents/fail-open-inventory.md F-005）。
function redirectWithDenial(
  request: NextRequest,
  reason: 'unauthenticated' | 'not_admin'
): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url))
  try {
    response.cookies.set(
      DENIAL_COOKIE_NAME,
      encodeProxyDenial({
        reason,
        route: request.nextUrl.pathname,
        method: request.method,
      }),
      {
        httpOnly: true,
        sameSite: 'lax',
        path: '/login',
        maxAge: 10,
        secure: process.env.NODE_ENV === 'production',
      }
    )
  } catch {
    // WHY: 印の付与は付随情報。失敗しても拒否（redirect）そのものは変えない
  }
  return response
}

/** 1 リクエストで使い回す nonce と、そこから作った CSP の値 */
type Csp = { nonce: string; value: string }

/**
 * WHY(唯一の入口、#757-16): proxy は 6 か所から応答を返す（未認証・MFA・admin 拒否・admin 通過・
 *      /login・通常）。各所で CSP を付ける形にすると、**返り口を 1 つ足した人が忘れた瞬間に
 *      その経路だけ CSP 無しになる**（docs/agents/check-design-pitfalls.md「間違えられる道を無くす」）。
 *      判定は handleRequest に閉じ込め、CSP を載せるのはここ 1 か所だけにする。
 */
export async function proxy(request: NextRequest) {
  const nonce = generateNonce()
  const csp: Csp = {
    nonce,
    value: buildCsp(nonce, {
      isDev: process.env.NODE_ENV === 'development',
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    }),
  }

  const response = await handleRequest(request, csp)
  response.headers.set(CSP_HEADER, csp.value)
  return response
}

async function handleRequest(request: NextRequest, csp: Csp) {
  let supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders(request, csp) } })

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
          supabaseResponse = NextResponse.next({ request: { headers: forwardedHeaders(request, csp) } })
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

  // WHY(#757-24): 未認証ガードより前に admin パスかどうかを判定する必要がある。
  //      ケース A（未認証で /admin）の印は未認証ガードの分岐で付けなければならないため、
  //      isAdminPath の判定を admin ガードから引き上げた
  const isAdminPath =
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')

  // 未認証ガード
  if (!user && !PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    if (isAdminPath) {
      return redirectWithDenial(request, 'unauthenticated')
    }
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
  // WHY: `!user` の分岐は上の未認証ガードで既に処理済みのため到達しない（デッドコードだったので削除）
  if (isAdminPath) {
    // WHY: resolveIsAdminはSupabaseClient(rpc呼び出し)+fetchのみに依存するため
    //      Edge RuntimeのmiddlewareでもService Role Keyなしに動作する。
    const isAdmin = await resolveIsAdmin(supabase, user!)

    if (!isAdmin) {
      return redirectWithDenial(request, 'not_admin')
    }

    return supabaseResponse
  }

  // WHY(#757-24): /login に印（拒否記録用の httpOnly cookie）が付いたまま来たら、
  //      応答で消す（同じ拒否が二重に記録されないため）。Server Component は cookie を
  //      書けないので、消す役は proxy にしか置けない。中身は forwardedHeaders() が
  //      ヘッダに載せ替えて Server Component へ渡している（削除が cookies() に先回りするため）
  if (pathname === '/login' && request.cookies.get(DENIAL_COOKIE_NAME)) {
    try {
      supabaseResponse.cookies.set(DENIAL_COOKIE_NAME, '', { maxAge: 0, path: '/login' })
    } catch {
      // WHY: 消去の失敗は付随情報。失敗しても /login の表示は続ける
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
