import { describe, it, expect } from 'vitest'
import { normalizeLotInput } from '@/lib/lot-search/normalize'

describe('normalizeLotInput（issue #803 決定3: 前後の空白のみ落とす）', () => {
  it('前後の半角空白を落とす', () => {
    expect(normalizeLotInput('  ABC123  ')).toBe('ABC123')
  })

  it('前後の全角空白も落とす（String.prototype.trim の対象）', () => {
    expect(normalizeLotInput('　ABC123　')).toBe('ABC123')
  })

  it('前後の改行・タブも落とす', () => {
    expect(normalizeLotInput('\n\tABC123\t\n')).toBe('ABC123')
  })

  it('内部の空白は変えない（決定3(c)の全角半角・ハイフン正規化はしない）', () => {
    expect(normalizeLotInput(' AB C-123 ')).toBe('AB C-123')
  })

  it('空文字はそのまま空文字', () => {
    expect(normalizeLotInput('   ')).toBe('')
  })
})
