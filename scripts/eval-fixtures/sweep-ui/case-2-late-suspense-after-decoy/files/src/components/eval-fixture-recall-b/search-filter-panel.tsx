// issue #431のrecallベンチマーク用fixture（case-2の「本命」側）。
// docs/agents/known-failure-patterns.md「Suspenseフォールバック未設定」を再現している:
// useSearchParams()をトップレベルで呼ぶクライアントコンポーネントが、
// <Suspense fallback={...}> でラップされずにexportされている。
// 同ディレクトリの alert-banner.tsx（辞書順で前）に別種の囮を置いてあるため、
// このファイルを検出するには「除外後の一覧を最後まで確認する」必要がある。
'use client'

import { useSearchParams } from 'next/navigation'

export function SearchFilterPanel() {
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''

  return (
    <div>
      <p>keyword: {keyword}</p>
    </div>
  )
}
