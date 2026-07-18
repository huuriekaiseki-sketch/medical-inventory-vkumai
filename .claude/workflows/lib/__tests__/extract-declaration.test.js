import { describe, it, expect } from 'vitest'
import { extractDeclaration } from '../extract-declaration.js'

describe('extractDeclaration', () => {
  it('exportなしのconst配列宣言を抽出する', () => {
    const source = "const FOO = ['a', 'b']\nconst BAR = ['c']"
    expect(extractDeclaration(source, 'FOO')).toBe("const FOO = ['a', 'b']")
  })

  it('export付きconst配列宣言はexportを除いて抽出する（exportなし版と一致させるため）', () => {
    const source = "export const FOO = ['a', 'b']\nconst BAR = ['c']"
    expect(extractDeclaration(source, 'FOO')).toBe("const FOO = ['a', 'b']")
  })

  it('末尾のセミコロンも含めて抽出する', () => {
    const source = "const FOO = ['a', 'b'];\nconst BAR = ['c'];"
    expect(extractDeclaration(source, 'FOO')).toBe("const FOO = ['a', 'b'];")
  })

  it('exportなしの関数宣言を抽出する', () => {
    const source = 'function isFoo(x) {\n  return x > 0\n}\nfunction isBar(x) { return x }'
    expect(extractDeclaration(source, 'isFoo')).toBe('function isFoo(x) {\n  return x > 0\n}')
  })

  it('export付き関数宣言はexportを除いて抽出する', () => {
    const source = 'export function isFoo(x) {\n  return x > 0\n}'
    expect(extractDeclaration(source, 'isFoo')).toBe('function isFoo(x) {\n  return x > 0\n}')
  })

  it('関数本体にネストしたブロック（if文）があっても対応する閉じ括弧まで正しく抽出する', () => {
    const source = 'function isFoo(x) {\n  if (x > 0) {\n    return true\n  }\n  return false\n}\nconst AFTER = 1'
    const result = extractDeclaration(source, 'isFoo')
    expect(result).toBe('function isFoo(x) {\n  if (x > 0) {\n    return true\n  }\n  return false\n}')
  })

  it('export付き・exportなしの宣言が同一の正規化結果を返す（同期テストの前提）', () => {
    const exported = "export const RISK_KEYWORDS = ['auth', 'facility']"
    const inline = "const RISK_KEYWORDS = ['auth', 'facility']"
    expect(extractDeclaration(exported, 'RISK_KEYWORDS')).toBe(extractDeclaration(inline, 'RISK_KEYWORDS'))
  })

  it('存在しない宣言名を指定するとエラーを投げる', () => {
    const source = "const FOO = ['a']"
    expect(() => extractDeclaration(source, 'NOPE')).toThrow()
  })
})
