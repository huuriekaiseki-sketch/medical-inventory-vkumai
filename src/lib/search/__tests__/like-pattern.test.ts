import { describe, it, expect } from 'vitest'
import { buildIlikeValue, buildIlikeValueUnquoted } from '../like-pattern'

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

// WHY(issue #803 統合時に実DBで発見): .ilike(column, value) へ単一カラムを直接渡す場合、
// buildIlikeValue の引用符囲みは PostgREST にリテラルな文字として渡ってしまい、
// 実DBでは常に0件になる不具合を引き起こす（.or() 経由でのみ引用符が意味を持つ）。
// 引用符を付けない専用の関数で、直接 .ilike() に渡しても正しく一致することを確認する。
describe('buildIlikeValueUnquoted', () => {
  it('通常の文字列は前後に%を付けるだけで、ダブルクォートで囲まない', () => {
    expect(buildIlikeValueUnquoted('abc')).toBe('%abc%')
  })

  it('%はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValueUnquoted('100%')).toBe('%100\\%%')
  })

  it('_はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValueUnquoted('a_b')).toBe('%a\\_b%')
  })

  it('\\はバックスラッシュでエスケープされる', () => {
    expect(buildIlikeValueUnquoted('a\\b')).toBe('%a\\\\b%')
  })

  it('"はそのまま残る（引用符で囲まないため、\\"へのエスケープはしない）', () => {
    expect(buildIlikeValueUnquoted('a"b')).toBe('%a"b%')
  })
})
