import { describe, it, expect } from 'vitest'
import { buildDbImplPrompt } from '../prompts/db-impl.js'

describe('buildDbImplPrompt', () => {
  it('specPathを本文に埋め込む', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('まず SPEC.md を Read ツールで読んでください')
  })

  it('DBスキーマ変更が不要な場合はblockedではなくpassにする旨を明記している(issue #389再発防止)', () => {
    const prompt = buildDbImplPrompt('SPEC.md')
    expect(prompt).toContain('これはblocked（着手不能）ではない')
  })

  it('DB変更不要の判断根拠をdetailに書くよう指示している', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('該当なし')
  })

  it('触ってよい範囲の制約(src/types等は触らない)を含む', () => {
    expect(buildDbImplPrompt('SPEC.md')).toContain('src/types/ / src/lib/ / src/app/ は触らないこと')
  })

  it('出力形式(status/detail/findings)の指示を含む', () => {
    const prompt = buildDbImplPrompt('SPEC.md')
    expect(prompt).toContain('## 出力形式')
    expect(prompt).toContain('pass:')
    expect(prompt).toContain('blocked:')
  })
})
