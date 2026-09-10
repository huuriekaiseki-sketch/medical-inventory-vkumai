import { Suspense } from 'react'

import { EvalFixtureCleanFilter } from '@/components/eval-fixture-clean/filter'

// useSearchParams を使う部分は Suspense の内側に置く。
// 外側（このページ）はサーバーコンポーネントのままにできる。
export default function EvalFixtureCleanPage() {
  return (
    <div>
      <h1>eval fixture clean</h1>
      <Suspense fallback={<p>読み込み中...</p>}>
        <EvalFixtureCleanFilter />
      </Suspense>
    </div>
  )
}
