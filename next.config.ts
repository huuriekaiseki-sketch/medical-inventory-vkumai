import type { NextConfig } from "next";

// WHY: issue #757 の 16（セキュリティヘッダ）。値は src/__tests__/next-config-headers.test.ts が固定する
//      （消えた・緩めた PR は CI で落ちる）。
//   - HSTS: 1 年 + サブドメイン。preload は登録すると取り消しに月単位かかるため付けない
//   - CSP は frame-ancestors だけ: Next.js のインラインスクリプトは nonce 無しでは script-src を絞れず、
//     'unsafe-inline' 付きの CSP は防御にならない。nonce 対応（proxy でヘッダ生成）は別 PR
//   - Permissions-Policy: この製品はカメラ・マイク・位置情報を使わない
export const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
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
