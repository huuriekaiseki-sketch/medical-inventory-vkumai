import { describe, it, expect } from 'vitest'
import { parseKeyword } from './api-keyword-query'

describe('parseKeyword', () => {
  it('keyword未指定なら ok: true, keyword: undefined を返す', () => {
    const result = parseKeyword(new URLSearchParams())
    expect(result).toEqual({ ok: true, keyword: undefined })
  })

  it('空文字列のkeywordは undefined 扱いになる', () => {
    const result = parseKeyword(new URLSearchParams('keyword='))
    expect(result).toEqual({ ok: true, keyword: undefined })
  })

  it('前後の空白のみのkeywordは undefined 扱いになる', () => {
    const result = parseKeyword(new URLSearchParams({ keyword: '   ' }))
    expect(result).toEqual({ ok: true, keyword: undefined })
  })

  it('100文字以内のkeywordはそのまま返す', () => {
    const kw = 'a'.repeat(100)
    const result = parseKeyword(new URLSearchParams({ keyword: kw }))
    expect(result).toEqual({ ok: true, keyword: kw })
  })

  it('101文字のkeywordは400エラーを返す', async () => {
    const kw = 'a'.repeat(101)
    const result = parseKeyword(new URLSearchParams({ keyword: kw }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = await result.response.json()
      expect(body.error).toContain('100')
    }
  })

  it('opts.maxLengthで上限を変更できる', () => {
    const result = parseKeyword(new URLSearchParams({ keyword: 'abc' }), { maxLength: 2 })
    expect(result.ok).toBe(false)
  })

  it('前後の空白を含めるとraw基準では102文字だが、trim後は100文字以内なのでokを返す', () => {
    // WHY: 長さ上限チェックはtrim後の値に対して行うべき（レビュー指摘: 正しさ minor）。
    //      前後の空白のみでraw文字列が上限を超える入力を不当に400で弾かないことを確認する
    const kw = ` ${'a'.repeat(100)} `
    expect(kw.length).toBe(102)
    const result = parseKeyword(new URLSearchParams({ keyword: kw }))
    expect(result).toEqual({ ok: true, keyword: 'a'.repeat(100) })
  })
})
