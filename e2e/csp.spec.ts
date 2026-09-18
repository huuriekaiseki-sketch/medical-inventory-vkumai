import { test, expect } from '@playwright/test'

// WHY: issue #757 の 16 の残り。CSP は**単体テストでは守れない**種類の変更で、
//      「ヘッダの文字列は正しいのに画面が壊れる / 逆に文字列を緩めても画面は壊れないので誰も気づかない」
//      の両方が起きる。このブランチの 1 本目（#757-24）でも、単体はモックで緑のまま
//      E2E が「記録 0 件」の本物のバグを捕まえている。
//
//      ここで測るのは 2 つ:
//        1. 実ブラウザが CSP 違反を 1 件も報告しないこと（= 画面を壊していない）
//        2. 応答の CSP が実際に効く形で出ていること（= 緩めたら気づける）
//
//      `securitypolicyviolation` を使うのは、CSP 違反が console の error として
//      出ない場合があるため（ブラウザ・違反種別による）。ブラウザ自身のイベントを直接見る。

const pages = [
  { name: 'ダッシュボード', path: '/' },
  { name: '施設一覧', path: '/facilities' },
  { name: 'デバイス一覧', path: '/products' },
  { name: '発注履歴', path: '/orders' },
  { name: 'ニュース', path: '/news' },
]

type Violation = { directive: string; blocked: string }

test.describe('CSP（#757 の 16）', () => {
  for (const { name, path } of pages) {
    test(`${name}（${path}）で CSP 違反が起きない`, async ({ page }) => {
      const violations: Violation[] = []
      await page.addInitScript(() => {
        ;(window as unknown as { __cspViolations: unknown[] }).__cspViolations = []
        document.addEventListener('securitypolicyviolation', (e) => {
          ;(window as unknown as { __cspViolations: unknown[] }).__cspViolations.push({
            directive: e.effectiveDirective,
            blocked: e.blockedURI,
          })
        })
      })

      await page.goto(path)
      await page.waitForLoadState('networkidle')

      violations.push(
        ...(await page.evaluate(
          () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations
        ))
      )

      expect(violations, `CSP 違反: ${JSON.stringify(violations)}`).toHaveLength(0)
    })
  }

  test('応答の CSP が nonce 付きで、script-src を実際に絞っている', async ({ page }) => {
    const response = await page.goto('/facilities')
    const csp = response?.headers()['content-security-policy']
    expect(csp, 'CSP ヘッダが無い').toBeTruthy()

    // 緩めたら落ちる側。'unsafe-inline' が script-src に入ると CSP は XSS に無力になる
    const scriptSrc = /script-src ([^;]+)/.exec(csp!)?.[1] ?? ''
    expect(scriptSrc).toContain("'nonce-")
    expect(scriptSrc).not.toContain("'unsafe-inline'")

    // 消えやすいディレクティブ
    for (const directive of ['default-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      expect(csp, `${directive} が消えている`).toContain(directive)
    }
  })

  test('nonce はリクエストごとに変わる', async ({ page }) => {
    const nonceOf = async () => {
      const response = await page.goto('/facilities')
      return /'nonce-([^']+)'/.exec(response?.headers()['content-security-policy'] ?? '')?.[1]
    }
    const first = await nonceOf()
    const second = await nonceOf()
    expect(first).toBeTruthy()
    expect(first).not.toBe(second)
  })

  test('ブラウザから Supabase へ繋がる（connect-src が塞いでいない）', async ({ page }) => {
    // 画面にデータが出ていれば、ブラウザ側クライアントの通信が通っている
    const violations: string[] = []
    await page.addInitScript(() => {
      ;(window as unknown as { __connectViolations: string[] }).__connectViolations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.effectiveDirective === 'connect-src') {
          ;(window as unknown as { __connectViolations: string[] }).__connectViolations.push(e.blockedURI)
        }
      })
    })
    await page.goto('/facilities')
    await page.waitForLoadState('networkidle')
    violations.push(
      ...(await page.evaluate(
        () => (window as unknown as { __connectViolations: string[] }).__connectViolations
      ))
    )
    expect(violations, `connect-src で塞がれた通信: ${violations.join(', ')}`).toHaveLength(0)
  })
})
