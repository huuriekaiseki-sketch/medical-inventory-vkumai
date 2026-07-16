// issue #431のrecallベンチマーク用fixture。既知の失敗パターン
// （docs/agents/known-failure-patterns.md「Suspenseフォールバック未設定」）を意図的に
// 再現している: useSearchParams()を使うクライアントコンポーネントが、
// Suspenseでラップされずにexportされている。
'use client'

import { useSearchParams } from 'next/navigation'

export default function EvalFixtureRecallPage() {
  const searchParams = useSearchParams()
  const filter = searchParams.get('filter') ?? 'all'

  return (
    <div>
      <p>filter: {filter}</p>
    </div>
  )
}
