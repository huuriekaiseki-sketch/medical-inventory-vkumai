import type { NextConfig } from "next";

// WHY: issue #757 の 16（セキュリティヘッダ）。値は src/__tests__/next-config-headers.test.ts が固定する
//      （消えた・緩めた PR は CI で落ちる）。
//   - HSTS: 1 年 + サブドメイン。preload は登録すると取り消しに月単位かかるため付けない
//   - **CSP はここに置かない**（2026-09-18、issue #757 の 16 の残り）。nonce はリクエストごとに
//     変わるので静的な設定では書けない。出所は src/lib/security/csp.ts で、載せるのは src/proxy.ts。
//     両方に書くと二重定義になり、どちらが効いているか読めなくなる。
//     frame-ancestors は CSP 側へ移した（X-Frame-Options: DENY は古いブラウザ向けに残す）
//   - Permissions-Policy: この製品はカメラ・マイク・位置情報を使わない
export const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
]

const nextConfig: NextConfig = {
  // 実測で X-Powered-By: Next.js が出ていた。フレームワーク名を名乗る必要は無い
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
};

export default nextConfig;
