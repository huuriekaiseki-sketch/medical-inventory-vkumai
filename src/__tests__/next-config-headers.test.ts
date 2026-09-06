import { describe, it, expect } from 'vitest'
import nextConfig, { securityHeaders } from '../../next.config'

// WHY: issue #757 の 16。セキュリティヘッダは「付けた」より「消えない」ことが大事で、
//      next.config を触る PR で黙って落ちるのを CI で止める。値の最低ラインもここで固定する。

const byKey = Object.fromEntries(securityHeaders.map((h) => [h.key.toLowerCase(), h.value]))

describe('セキュリティヘッダ（next.config.ts）', () => {
  it('X-Powered-By を出さない', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  it('全パスに securityHeaders が付く', async () => {
    const rules = await nextConfig.headers!()
    const all = rules.find((r) => r.source === '/(.*)')
    expect(all?.headers).toEqual(securityHeaders)
  })

  it.each([
    ['x-frame-options', 'DENY'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['x-dns-prefetch-control', 'off'],
  ])('%s = %s', (key, value) => {
    expect(byKey[key]).toBe(value)
  })

  it('HSTS は 1 年以上で includeSubDomains 付き（preload は付けない）', () => {
    const hsts = byKey['strict-transport-security']
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1])
    expect(maxAge).toBeGreaterThanOrEqual(31536000)
    expect(hsts).toContain('includeSubDomains')
    expect(hsts).not.toContain('preload')
  })

  it("CSP は frame-ancestors 'none' を含み、'unsafe-inline' 付きの script-src で防御を偽装しない", () => {
    const csp = byKey['content-security-policy']
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })

  it('Permissions-Policy はカメラ・マイク・位置情報を無効にする', () => {
    const pp = byKey['permissions-policy']
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) expect(pp).toContain(feature)
  })
})
