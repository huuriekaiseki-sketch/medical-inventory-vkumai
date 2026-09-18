// WHY: issue #757 の 16 の残り。CSP を `frame-ancestors 'none'` だけの状態から nonce ベースへ広げる。
//      以前は「Next.js のインラインスクリプトは nonce 無しでは script-src を絞れない」ため
//      frame-ancestors しか置けなかった（next.config.ts の旧コメント）。nonce を proxy で作れば絞れる。
//
//      **nonce 方式は静的化を諦める代わりに強い CSP を得る取引**だが、この製品は 2026-09-18 の
//      実測で **全 44 ルートが動的（ƒ）・静的ルート 0 件**だったので、諦めるものが無い。
//
//      組み立てを proxy から切り離してあるのは、ディレクティブが緩んだら落ちる検査
//      （src/lib/security/__tests__/csp.test.ts）を proxy の実行環境なしで書くため。

/** CSP の nonce。リクエストごとに新しく作る（使い回すと nonce の意味が無い） */
export function generateNonce(): string {
  // WHY(Buffer を使わない): Next.js のドキュメントの例は Buffer.from(crypto.randomUUID()) だが、
  //      proxy は Edge Runtime で動くため Node.js の API に寄せたくない。
  //      Web 標準の crypto.getRandomValues + btoa だけで作る。
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Supabase の URL から connect-src に載せる origin を取り出す。
 * WHY: ブラウザの Supabase クライアント（src/lib/supabase/client.ts の createBrowserClient）が
 *      ブラウザから直接 Supabase を叩くので、ここが抜けるとログインも全データ取得も死ぬ。
 *      パス付きの URL をそのまま書くと CSP のソース式として意図しない一致になるため origin だけにする。
 */
export function supabaseOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    // WHY: 壊れた URL は connect-src に載せない。Supabase の URL が不正なら
    //      createServerClient / createBrowserClient 側が先に落ちるので、ここで握り潰しても
    //      「原因の分からない不通」にはならない
    return null
  }
}

export type CspOptions = {
  /** 開発時のみ 'unsafe-eval' を許す（React が eval でデバッグ情報を作るため。Next.js のドキュメント記載） */
  isDev: boolean
  /** NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl?: string
}

/**
 * CSP のヘッダ値を組み立てる。**CSP の出所はここ 1 か所だけ**（next.config.ts には置かない）。
 * 二重に定義すると、どちらが効いているのかが読めなくなる。
 */
export function buildCsp(nonce: string, { isDev, supabaseUrl }: CspOptions): string {
  const origin = supabaseOrigin(supabaseUrl)
  const connectSrc = ["'self'", origin].filter(Boolean).join(' ')

  const directives = [
    `default-src 'self'`,
    // 'strict-dynamic': nonce で許したスクリプトが読み込む子スクリプトも許す（Next.js のチャンク読み込み）
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // WHY('unsafe-inline' を残す、2026-09-18 の判断 A-1): src/app と src/components の 53 ファイルが
    //      インラインの style={{...}} 属性を使っている。style-src を絞ると UI が全壊する。
    //      style-src-attr で属性だけ許す案（A-2）は、style-src-attr を解さないブラウザが
    //      style-src に落ちて同じく全壊するため、医療現場で使う製品では採らない。
    //      守りたいのは第一にスクリプト実行で、style の注入は深刻度が一段低い。
    //      インライン style の CSS 化は本 PR の範囲外（別 issue）。
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    // next/font/google はビルド時に取得して自己ホストする（外部ドメインの許可は要らない）
    `font-src 'self'`,
    `connect-src ${connectSrc}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    'upgrade-insecure-requests',
  ]

  return directives.join('; ')
}
