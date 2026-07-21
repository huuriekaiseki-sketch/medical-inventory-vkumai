import { describe, it, expect } from 'vitest'
import { buildIlikeValue } from '../like-pattern'

// WHY: SPEC Set A テスト観点。% _ \ " , ( ) を含むキーワードが正しくエスケープされることを
// 単体で検証する（compatibilities/repository.ts に元々存在した実装の移設に伴う回帰確認）。
describe('buildIlikeValue', () => {
  it('通常の文字列は前後に%を付けてダブルクォートで囲む', () => {
    expect(buildIlikeValue('abc')).toBe('"%abc%"')
  })

  it('%はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValue('100%')).toBe('"%100\\%%"')
  })

  it('_はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValue('a_b')).toBe('"%a\\_b%"')
  })

  it('\\はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValue('a\\b')).toBe('"%a\\\\b%"')
  })

  it('"はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValue('a"b')).toBe('"%a\\"b%"')
  })

  it(',はダブルクォートで囲まれるためそのまま値の中に残る', () => {
    expect(buildIlikeValue('a,b')).toBe('"%a,b%"')
  })

  it('(と)はダブルクォートで囲まれるためそのまま値の中に残る', () => {
    expect(buildIlikeValue('a(b)c')).toBe('"%a(b)c%"')
  })

  it('複数の特殊文字が混在しても正しくエスケープされる', () => {
    expect(buildIlikeValue('100%_テスト,製品')).toBe('"%100\\%\\_テスト,製品%"')
  })
})
