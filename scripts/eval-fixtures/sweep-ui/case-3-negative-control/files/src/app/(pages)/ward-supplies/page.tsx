import { Suspense } from 'react'

import { WardSupplyFilter } from '@/components/ward-supplies/filter'

// useSearchParams を使う部分は Suspense の内側に置く。
// 外側（このページ）はサーバーコンポーネントのままにできる。
export default function WardSuppliesPage() {
  return (
    <div>
      <h1>病棟備品</h1>
      <Suspense fallback={<p>読み込み中...</p>}>
        <WardSupplyFilter />
      </Suspense>
    </div>
  )
}
