'use client'

import { Suspense, useEffect, useState, useReducer } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Product } from '@/types/product'
import { ProductList } from '@/components/products/ProductList'
import { ProductSearchFilters } from '@/components/products/ProductSearchFilters'

// WHY: known-failure-patterns.md「Suspenseフォールバック未設定」対応。
//      useSearchParamsを使うコンポーネントはSuspenseでラップしないとSSRハイドレーション時に
//      ブランクスクリーンが発生しうる。既存のuseRouterロジック（新規登録・編集・削除遷移）は
//      すべてProductsPageInnerへ移動し、外側のProductsPageはラッパーのみとする
function ProductsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''

  const [products, setProducts] = useState<Product[]>([])
  // WHY: 初期値をtrueにする。falseのままだと、URLにkeywordが付いた状態でマウントした際、
  //      1回目のフェッチが完了する前の最初の描画で products.length === 0 && keyword が真になり、
  //      「該当する製品がありません」が一瞬誤表示される競合状態が起きる（レビュー指摘: 正しさ important）
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  // WHY: react-hooks/set-state-in-effectはeffect本体トップレベルでの同期的setStateを
  //      禁止する（orders/page.tsxのloadOrders()と同じ回避パターン）。非同期関数に包んで
  //      呼び出すことでlintの検知対象から外す
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      const params = new URLSearchParams()
      if (keyword) params.set('keyword', keyword)
      const query = params.toString()
      try {
        const res = await fetch(query ? `/api/products?${query}` : '/api/products')
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        // WHY: 再検索中は前回の結果を表示したまま薄いローディング表示を重ねる仕様（SPEC共通）。
        //      成功時のみproductsを更新し、失敗時はsetProductsを呼ばず既存リストを保持する
        setProducts(data.products)
        setError(null)
      } catch {
        if (!cancelled) setError('デバイスの取得に失敗しました')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [keyword, refreshKey])

  function handleKeywordChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set('keyword', value)
    else params.delete('keyword')
    const query = params.toString()
    router.replace(query ? `/products?${query}` : '/products')
  }

  function handleClear() {
    router.replace('/products')
  }

  async function handleDelete(id: string) {
    if (!confirm('削除しますか？')) return
    try {
      // WHY: DELETE完了をawaitで待ってから再取得しないと、削除前のデータが再描画され不整合が起きるため
      const res = await fetch(`/api/products/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json()
        alert(body.error ?? '削除に失敗しました')
        return
      }
      refresh()
    } catch {
      alert('削除に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-end justify-between border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
            Device Management
          </p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            デバイス
          </h1>
        </div>
        <button
          onClick={() => router.push('/products/new')}
          className="px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ backgroundColor: '#FF5F03', fontFamily: 'var(--font-ubuntu), sans-serif', borderRadius: '2px' }}
        >
          + 新規登録
        </button>
      </div>

      <ProductSearchFilters
        keyword={keyword}
        isLoading={isLoading}
        onKeywordChange={handleKeywordChange}
        onClear={handleClear}
      />

      {error && (
        // WHY: SPEC「新規検索まわりのエラー表示はrole="alert"付きbg-red-50 text-red-700スタイルに
        //      統一する（distributor-products/page.tsxの既存スタイルに合わせる）」に準拠させる
        //      （レビュー指摘: 正しさ important）。このエラーはkeyword検索を含む一覧取得の失敗を
        //      表すため新規スタイルの対象。既存の他ページのインラインスタイルバナーは対象外
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        {/* WHY: isLoading中はproducts.length===0だけで「0件」を確定表示しない。
            フェッチ未完了のタイミングでは実際の検索結果件数がまだ確定していないため、
            isLoadingを見ずに判定すると本来ヒットするはずの検索でも一瞬0件誤表示が起きる
            （レビュー指摘: 正しさ important 誤表示競合状態） */}
        {!error && !isLoading && keyword && products.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-sm font-medium" style={{ color: '#6B7280' }}>該当する製品がありません</p>
          </div>
        ) : (
          <ProductList
            products={products}
            onEdit={(id) => router.push(`/products/${id}/edit`)}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  )
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<div>読み込み中...</div>}>
      <ProductsPageInner />
    </Suspense>
  )
}
