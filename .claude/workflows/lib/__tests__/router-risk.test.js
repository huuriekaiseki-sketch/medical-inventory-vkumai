import { describe, it, expect } from 'vitest'
import { classifyRisk } from '../router-risk.js'

describe('classifyRisk', () => {
  it('taskDescriptionにキーワードがあれば高リスク（後方互換）', () => {
    const result = classifyRisk('facility周りのバグ修正', [])
    expect(result.isHighRisk).toBe(true)
    expect(result.matchedKeywords).toContain('facility')
  })

  it('taskDescriptionにキーワードが無くchangedFilesも空なら高リスクではない', () => {
    const result = classifyRisk('ボタンの色を変える', [])
    expect(result.isHighRisk).toBe(false)
  })

  it('taskDescriptionにキーワードが無くてもsupabase/migrations/配下の変更があれば高リスク', () => {
    const result = classifyRisk('ちょっとしたリファクタ', ['supabase/migrations/20260711000000_add_index.sql'])
    expect(result.isHighRisk).toBe(true)
    expect(result.matchedPaths).toEqual(['supabase/migrations/20260711000000_add_index.sql'])
  })

  it('taskDescriptionにキーワードが無くてもsrc/lib/supabase/配下の変更があれば高リスク', () => {
    const result = classifyRisk('リファクタ', ['src/lib/supabase/orders.ts'])
    expect(result.isHighRisk).toBe(true)
  })

  it('taskDescriptionにキーワードが無くてもmiddleware.tsの変更があれば高リスク', () => {
    const result = classifyRisk('リファクタ', ['middleware.ts'])
    expect(result.isHighRisk).toBe(true)
  })

  it('taskDescriptionにキーワードが無くてもドメインキーワードを含むパスの変更があれば高リスク（issue #286の完了条件）', () => {
    const result = classifyRisk('画面のちょっとした調整', ['src/app/(pages)/facility/settings/page.tsx'])
    expect(result.isHighRisk).toBe(true)
    expect(result.matchedPaths.length).toBe(1)
  })

  it('リスクに無関係なファイルのみの変更なら高リスクではない', () => {
    const result = classifyRisk('ボタンの色を変える', ['src/components/Button.tsx', 'src/app/page.tsx'])
    expect(result.isHighRisk).toBe(false)
    expect(result.matchedPaths).toEqual([])
  })

  it('taskDescriptionとchangedFilesの両方が該当しても問題なく高リスクと判定する', () => {
    const result = classifyRisk('RLSポリシーの見直し', ['supabase/migrations/20260711000000_rls.sql'])
    expect(result.isHighRisk).toBe(true)
    expect(result.matchedKeywords.length).toBeGreaterThan(0)
    expect(result.matchedPaths.length).toBeGreaterThan(0)
  })

  it('changedFiles未指定でもエラーにならない（デフォルト空配列）', () => {
    const result = classifyRisk('ボタンの色を変える')
    expect(result.isHighRisk).toBe(false)
  })

  it('changedFilesが提供されmatchedPathsが空なら、taskDescriptionに否定文脈でキーワードが含まれていても高リスクとしない（issue #456: ルーター誤判定の再現ケース）', () => {
    const result = classifyRisk(
      'DB/RLS/auth/facility等のドメインには触れない。.claude/workflows/*.jsのみを変更する',
      ['.claude/workflows/aidd-1-1-deep-task.js', '.claude/workflows/aidd-phase2.js']
    )
    expect(result.isHighRisk).toBe(false)
    expect(result.matchedPaths).toEqual([])
    // キーワード自体は否定文脈でも引き続き検出される（isHighRiskの判定には使わないが、補助情報として残す）
    expect(result.matchedKeywords.length).toBeGreaterThan(0)
  })

  it('changedFilesが提供されていてもmatchedPathsが1件でもあれば高リスク（キーワードが無くても）', () => {
    const result = classifyRisk('画面の調整のみ', ['src/lib/supabase/orders.ts', 'src/components/Button.tsx'])
    expect(result.isHighRisk).toBe(true)
    expect(result.matchedPaths).toEqual(['src/lib/supabase/orders.ts'])
  })

  it('changedFilesが全て.claude/workflows/配下ならメタ改修と判定する（issue #457）', () => {
    const result = classifyRisk('Workflow DSL未使用機能の採用', ['.claude/workflows/aidd-phase2.js', '.claude/workflows/aidd-1-1-deep-task.js'])
    expect(result.isMetaModification).toBe(true)
  })

  it('changedFilesが全て.claude/agents/配下ならメタ改修と判定する（issue #457）', () => {
    const result = classifyRisk('reviewerエージェントの指示文を調整', ['.claude/agents/reviewer.md'])
    expect(result.isMetaModification).toBe(true)
  })

  it('changedFilesが全てdocs/agents/配下ならメタ改修と判定する（issue #457）', () => {
    const result = classifyRisk('common.mdにルールを追記', ['docs/agents/common.md'])
    expect(result.isMetaModification).toBe(true)
  })

  it('changedFilesがメタ改修パスとプロダクトコードの混在なら、メタ改修とは判定しない', () => {
    const result = classifyRisk('ルーターとUIを両方直す', ['.claude/workflows/aidd-phase1-router.js', 'src/app/page.tsx'])
    expect(result.isMetaModification).toBe(false)
  })

  it('changedFilesが空ならメタ改修と判定しない', () => {
    const result = classifyRisk('現在のコードベース全体の調査', [])
    expect(result.isMetaModification).toBe(false)
  })

  it('メタ改修パスがドメインキーワードを含んでいても、メタ改修判定がisHighRiskより優先される（issue #457症状2の再現ケース）', () => {
    // docs/agents/配下だが「policy」という語をファイル名に含むため、素朴なキーワード一致だと
    // 誤ってRISK_DOMAIN_KEYWORDSにヒットしうる。メタ改修判定が優先されるべきケース。
    const result = classifyRisk('AIDDのpolicyドキュメントを更新', ['docs/agents/policy-notes.md'])
    expect(result.isMetaModification).toBe(true)
    expect(result.isHighRisk).toBe(false)
  })
})
