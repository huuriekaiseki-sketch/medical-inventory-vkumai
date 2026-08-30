import { describe, it, expect } from 'vitest'
import { classifyRisk, classifyRoute } from '../router-risk.js'

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

  it('taskDescriptionにキーワードが無くてもproxy.tsの変更があれば高リスク（issue #681。Next.js 16でmiddleware.tsから改名）', () => {
    const result = classifyRisk('リファクタ', ['src/proxy.ts'])
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
})

describe('classifyRoute（issue #457）', () => {
  it('症状1の再現ケース: 「DB/RLS/authには触れない」という否定文でもchangedFilesが.claude/workflows/配下のみならmetaルートになる', () => {
    const result = classifyRoute(
      'AIDDルーターのメタ改修判定を追加する。DB/RLS/authには触れない。',
      ['.claude/workflows/aidd-phase1-router.js']
    )
    expect(result.route).toBe('meta')
    expect(result.isMetaChange).toBe(true)
    expect(result.matchedKeywords).toEqual([])
    expect(result.matchedPaths).toEqual([])
  })

  it('changedFilesが.claude/agents/配下のみでもmetaルートになる', () => {
    const result = classifyRoute('sweepエージェントのプロンプトを調整', ['.claude/agents/sweep-db.md'])
    expect(result.route).toBe('meta')
  })

  it('changedFilesがdocs/agents/配下のみでもmetaルートになる', () => {
    const result = classifyRoute('common.mdにルール追記', ['docs/agents/common.md'])
    expect(result.route).toBe('meta')
  })

  it('changedFilesがツール層とプロダクトコードの混在ならmetaルートにならず、既存のTRI/RISK判定に従う（高リスクパスがあればdeep）', () => {
    const result = classifyRoute('ルーター調整とfacility周りの修正', [
      '.claude/workflows/aidd-phase1-router.js',
      'src/app/(pages)/facility/settings/page.tsx',
    ])
    expect(result.route).toBe('deep')
    expect(result.isMetaChange).toBe(false)
    expect(result.matchedPaths).toContain('src/app/(pages)/facility/settings/page.tsx')
  })

  it('changedFilesがツール層と無関係なプロダクトコードの混在ならmetaルートにならず、既存判定でlightになりうる', () => {
    const result = classifyRoute('リファクタ', ['.claude/workflows/aidd-phase1-router.js', 'src/components/Button.tsx'])
    expect(result.route).toBe('light')
    expect(result.isMetaChange).toBe(false)
  })

  it('changedFiles未指定（空配列）でtaskDescriptionにキーワードがあればconfirmルートになる（issue #500: 無人でdeepへ自動振り分けしない）', () => {
    const result = classifyRoute('facility周りのバグ修正', [])
    expect(result.route).toBe('confirm')
    expect(result.isMetaChange).toBe(false)
    expect(result.matchedKeywords).toContain('facility')
  })

  it('changedFiles未指定・taskDescriptionにもキーワードが無ければlightルートになる', () => {
    const result = classifyRoute('ボタンの色を変える', [])
    expect(result.route).toBe('light')
  })

  it('既存の高リスクパス判定（supabase/migrations/等）はメタ改修判定の追加後も一切緩まない', () => {
    const result = classifyRoute('ちょっとしたリファクタ', ['supabase/migrations/20260711000000_add_index.sql'])
    expect(result.route).toBe('deep')
    expect(result.isHighRisk).toBe(true)
    expect(result.isMetaChange).toBe(false)
  })
})

describe('classifyRoute（issue #500: changedFiles空時のキーワード誤判定フォールバックをconfirmルートに変更）', () => {
  it('再現ケース: 否定文脈でキーワードが含まれ、changedFilesが空(実装前のPhase1着手時の通常呼び出し)だとconfirmルートになり、deepへ自動振り分けしない', () => {
    const result = classifyRoute(
      'products一覧に検索UIを追加する。DBスキーマ変更・facility/tenant/auth境界には触れない想定。',
      []
    )
    expect(result.route).toBe('confirm')
    expect(result.isMetaChange).toBe(false)
    // キーワード自体は否定文脈でも引き続き検出される（confirmルートの判断材料として補助的に残す）
    expect(result.matchedKeywords.length).toBeGreaterThan(0)
    expect(result.matchedPaths).toEqual([])
  })

  it('changedFilesが1件以上あればconfirmルートにならず、従来通りmatchedPathsのみでisHighRiskが決まる（issue #456の修正は維持）', () => {
    const result = classifyRoute(
      'DBスキーマ変更・facility/tenant/auth境界には触れない想定。',
      ['.claude/workflows/aidd-1-1-deep-task.js']
    )
    expect(result.route).not.toBe('confirm')
  })

  it('changedFiles空でもキーワードが1つも一致しなければconfirmルートにならずlightルートになる', () => {
    const result = classifyRoute('ボタンの色を変える', [])
    expect(result.route).toBe('light')
  })
})
