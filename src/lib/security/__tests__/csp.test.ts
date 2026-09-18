// WHY: issue #757 の 16 の残り。CSP は「入れた日に緑」だけでは守れない。
//      後から `'unsafe-inline'` を script-src に足す・nonce を落とす・ディレクティブを削る、の
//      どれをやっても**静かに防御が消える**（画面は壊れないので誰も気づかない）。
//      ここは「緩んだら落ちる」側を固定する検査で、C-022（緑であることと守っていることは別）の対。
import { describe, expect, it } from 'vitest'
import { buildCsp, generateNonce, supabaseOrigin } from '../csp'

const NONCE = 'test-nonce-value'
const OPTS = { isDev: false, supabaseUrl: 'https://example.supabase.co' }

/** ディレクティブ名 → 値（`; ` 区切りの CSP を読む） */
function parse(csp: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of csp.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [name, ...rest] = trimmed.split(/\s+/)
    out[name] = rest.join(' ')
  }
  return out
}

describe('generateNonce', () => {
  it('呼ぶたびに違う値になる（使い回すと nonce の意味が無い）', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateNonce()))
    expect(seen.size).toBe(50)
  })

  it('十分な長さがある（当てられる短さにしない）', () => {
    // 16 バイトを base64 にするので 24 文字
    expect(generateNonce().length).toBeGreaterThanOrEqual(20)
  })
})

describe('supabaseOrigin', () => {
  it('origin だけを取り出す（パスを載せない）', () => {
    expect(supabaseOrigin('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co')
  })

  it('壊れた URL と未設定は null（connect-src に載せない）', () => {
    expect(supabaseOrigin('not a url')).toBeNull()
    expect(supabaseOrigin(undefined)).toBeNull()
  })
})

describe('buildCsp: 守っているべきこと', () => {
  const csp = buildCsp(NONCE, OPTS)
  const d = parse(csp)

  it('script-src に nonce が入る', () => {
    expect(d['script-src']).toContain(`'nonce-${NONCE}'`)
  })

  // ここが本丸。'unsafe-inline' が script-src に入った瞬間、この CSP は XSS に対して無力になる
  it("script-src に 'unsafe-inline' が入っていない", () => {
    expect(d['script-src']).not.toContain("'unsafe-inline'")
  })

  it("本番では 'unsafe-eval' を許さない", () => {
    expect(d['script-src']).not.toContain("'unsafe-eval'")
  })

  it("開発時だけ 'unsafe-eval' を許す（React の eval によるデバッグ情報のため）", () => {
    const dev = parse(buildCsp(NONCE, { ...OPTS, isDev: true }))
    expect(dev['script-src']).toContain("'unsafe-eval'")
  })

  it('connect-src に Supabase の origin が入る（抜けるとログインごと死ぬ）', () => {
    expect(d['connect-src']).toContain('https://example.supabase.co')
    expect(d['connect-src']).toContain("'self'")
  })

  it('Supabase の URL が無ければ self だけになる（壊れた値を載せない）', () => {
    const none = parse(buildCsp(NONCE, { isDev: false, supabaseUrl: undefined }))
    expect(none['connect-src']).toBe("'self'")
  })

  // 消された瞬間に落ちる。値まで見るのは「ディレクティブはあるが空」を通さないため
  it.each([
    ['default-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
    ['font-src', "'self'"],
  ])('%s が %s のまま残っている', (name, value) => {
    expect(d[name]).toBe(value)
  })

  it('upgrade-insecure-requests が残っている', () => {
    expect(csp).toContain('upgrade-insecure-requests')
  })

  // WHY: 判断 A-1 の記録。style だけは 'unsafe-inline' を**意図して**許している
  //      （src/app と src/components の 53 ファイルがインライン style 属性を使うため）。
  //      この行が落ちたら、意図せず style を絞って UI を壊したということ。
  it("style-src は 'unsafe-inline' を意図して許している（判断 A-1）", () => {
    expect(d['style-src']).toContain("'unsafe-inline'")
  })
})
