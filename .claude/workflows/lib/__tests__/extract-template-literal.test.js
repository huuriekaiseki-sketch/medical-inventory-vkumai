import { describe, it, expect } from 'vitest'
import { extractTemplateLiteralContaining } from '../prompts/extract-template-literal.js'

describe('extractTemplateLiteralContaining', () => {
  it('マーカーを含むテンプレートリテラルの中身を抽出する', () => {
    const source = "const x = `hello ${name} world, marker-here`\nconst y = `other`"
    expect(extractTemplateLiteralContaining(source, 'marker-here')).toBe('hello ${name} world, marker-here')
  })

  it('${}内にネストした波括弧があっても正しく終端を判定する', () => {
    const source = "const x = `a ${fn({ k: 1 })} b marker`"
    expect(extractTemplateLiteralContaining(source, 'marker')).toBe('a ${fn({ k: 1 })} b marker')
  })

  it('複数のテンプレートリテラルから該当するものだけを選ぶ', () => {
    const source = "const a = `first marker-a`\nconst b = `second marker-b`"
    expect(extractTemplateLiteralContaining(source, 'marker-b')).toBe('second marker-b')
  })

  it('マーカーを含むリテラルが無ければエラーを投げる', () => {
    const source = "const a = `first`"
    expect(() => extractTemplateLiteralContaining(source, 'nope')).toThrow()
  })

  it('複数行にまたがるテンプレートリテラルも抽出できる', () => {
    const source = "const x = `line1\nline2 marker\nline3`"
    expect(extractTemplateLiteralContaining(source, 'marker')).toBe('line1\nline2 marker\nline3')
  })
})
