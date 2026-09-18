import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { keywordQueryShape } from './api-keyword-query'

// WHY(2026-09-09): `parseKeyword(URLSearchParams)` を `keywordQueryShape()`（zod の形）へ移した。
//      route が `searchParams` を取り出して渡す形をやめ、クエリを読む唯一の入口
//      （`parseQuery`）に穴を残さないため。**振る舞いは移行前と同じ**なので、
//      ここで確かめる項目も同じ（未指定・空・空白のみ・境界・上限超え・上限の変更・trim 基準）。

const parse = (params: Record<string, string>, maxLength?: number) =>
  z.object(keywordQueryShape(maxLength)).safeParse(params)

describe('keywordQueryShape', () => {
  it('keyword 未指定なら undefined', () => {
    const result = parse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.keyword).toBeUndefined()
  })

  it('空文字列の keyword は undefined 扱いになる', () => {
    const result = parse({ keyword: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.keyword).toBeUndefined()
  })

  it('前後の空白のみの keyword は undefined 扱いになる', () => {
    const result = parse({ keyword: '   ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.keyword).toBeUndefined()
  })

  it('100 文字ちょうどの keyword はそのまま返す（境界）', () => {
    const kw = 'a'.repeat(100)
    const result = parse({ keyword: kw })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.keyword).toBe(kw)
  })

  it('101 文字の keyword は拒否され、上限が文言に出る（境界の反対側）', () => {
    const result = parse({ keyword: 'a'.repeat(101) })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].message).toContain('100')
  })

  it('上限は引数で変えられる', () => {
    expect(parse({ keyword: 'abc' }, 2).success).toBe(false)
    expect(parse({ keyword: 'ab' }, 2).success).toBe(true)
  })

  it('前後の空白を含めると 102 文字でも、trim 後が 100 文字以内なら通る', () => {
    // WHY: 長さの判定は trim 後の「実際に検索へ使う値」に対して行う（レビュー指摘: 正しさ minor）。
    //      前後の空白だけで上限を超える入力を不当に 400 で弾かない
    const kw = ` ${'a'.repeat(100)} `
    expect(kw.length).toBe(102)
    const result = parse({ keyword: kw })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.keyword).toBe('a'.repeat(100))
  })
})
