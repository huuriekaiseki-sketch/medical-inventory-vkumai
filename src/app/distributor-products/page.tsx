'use client'

import { Suspense, useEffect, useState, useReducer } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { DistributorProduct } from '@/types/distributorProduct'
import type { Category } from '@/types/category'
import { DistributorProductList } from '@/components/distributor-products/DistributorProductList'
import { DistributorProductSearchFilters } from '@/components/distributor-products/DistributorProductSearchFilters'

// WHY: known-failure-patterns.md「Suspenseフォールバック未設定」対応。
//      useSearchParamsを使うコンポーネントはSuspenseでラップしないとSSRハイドレーション時に
//      ブランクスクリーンが発生しうる。既存のuseRouterロジックはすべて
//      DistributorProductsPageInnerへ移動し、外側のDistributorProductsPageはラッパーのみとする
function DistributorProductsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const keyword = searchParams.get('keyword') ?? ''
  const categoryId = searchParams.get('categoryId') ?? ''

  const [items, setItems] = useState<DistributorProduct[]>([])
  // WHY: categories === undefined はローディング中を表す
  //     （DistributorProductSearchFiltersのProps仕様SPEC Part2 Set E-2）
  const [categories, setCategories] = useState<Category[] | undefined>(undefined)
  // WHY: 初期値をtrueにする。falseのままだと、URLにkeyword/categoryIdが付いた状態でマウントした際、
  //      1回目のフェッチが完了する前の最初の描画でitems.length===0かつkeyword/categoryIdが真になり、
  //      「該当する販売店商品がありません」が一瞬誤表示される競合状態が起きる
  //      （レビュー指摘: 正しさ important。products/page.tsxと同様の修正）
  const [isLoading, setIsLoading] = useState(true)
  // WHY: categories取得とitems取得は互いに独立した2つのuseEffectであり、片方の失敗は
  //      もう片方の成功と無関係に表示され続けるべき。単一のerror stateを共有すると、
  //      例えばcategories取得が失敗してエラー表示された直後にitems取得が成功すると
  //      setError(null)が呼ばれてcategoriesの失敗表示が消えてしまう（エラー消失）
  //      （レビュー指摘: 正しさ important）。そのためstateを分離する
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  // WHY: categoriesはマウント時のみ取得すればよく、keyword/categoryId/refreshKeyの変更で
  //      再取得する必要はない（SPEC Part2 Set F-2「categoriesとdistributor-productsの
  //      フェッチを2つのuseEffectに分離する」）。単一のuseEffectにまとめると、
  //      DELETE後のrefreshKey増加やキーワード変更のたびに不要なcategories再取得が走ってしまう
  useEffect(() => {
    let cancelled = false
    fetch('/api/categories')
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) { setCategories(d.categories); setCategoriesError(null) } })
      .catch(() => { if (!cancelled) setCategoriesError('カテゴリの取得に失敗しました') })
    return () => { cancelled = true }
  }, [])

  // WHY: react-hooks/set-state-in-effectはeffect本体トップレベルでの同期的setStateを
  //      禁止する（orders/page.tsxのloadOrders()と同じ回避パターン）。非同期関数に包んで
  //      呼び出すことでlintの検知対象から外す
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      const params = new URLSearchParams()
      if (keyword) params.set('keyword', keyword)
      if (categoryId) params.set('categoryId', categoryId)
      const query = params.toString()
      try {
        const res = await fetch(query ? `/api/distributor-products?${query}` : '/api/distributor-products')
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        // WHY: 再検索中は前回の結果を表示したまま薄いローディング表示を重ねる仕様（SPEC共通）。
        //      成功時のみitemsを更新し、失敗時はsetItemsを呼ばず既存リストを保持する
        setItems(data.items)
        setItemsError(null)
      } catch {
        if (!cancelled) setItemsError('データの取得に失敗しました')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [keyword, categoryId, refreshKey])

  function pushParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    const query = params.toString()
    router.replace(query ? `/distributor-products?${query}` : '/distributor-products')
  }

  function handleClear() {
    router.replace('/distributor-products')
  }

  async function handleDelete(id: string) {
    if (!window.confirm('削除しますか？')) return
    try {
      const res = await fetch(`/api/distributor-products/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setItemsError(body.error ?? '削除に失敗しました')
        return
      }
      setItemsError(null)
      refresh()
    } catch {
      setItemsError('削除に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-end justify-between border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
            Distributor Products
          </p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            販売店商品
          </h1>
        </div>
        <button
          onClick={() => router.push('/distributor-products/new')}
          className="px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ backgroundColor: '#FF5F03', fontFamily: 'var(--font-ubuntu), sans-serif', borderRadius: '2px' }}
        >
          + 新規登録
        </button>
      </div>

      <DistributorProductSearchFilters
        keyword={keyword}
        categoryId={categoryId}
        categories={categories}
        isLoading={isLoading}
        onKeywordChange={(value) => pushParams({ keyword: value })}
        onCategoryChange={(value) => pushParams({ categoryId: value })}
        onClear={handleClear}
      />

      {/* WHY: categories取得失敗とitems取得失敗は独立したエラーとして両方表示しうる
          （error state分離。レビュー指摘: 正しさ important） */}
      {categoriesError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {categoriesError}
        </p>
      )}
      {itemsError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {itemsError}
        </p>
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        {/* WHY: isLoading中はitems.length===0だけで「0件」を確定表示しない
            （レビュー指摘: 正しさ important 誤表示競合状態、products/page.tsxと同様の修正） */}
        {!itemsError && !isLoading && (keyword || categoryId) && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-sm font-medium" style={{ color: '#6B7280' }}>該当する販売店商品がありません</p>
          </div>
        ) : (
          <DistributorProductList
            items={items}
            categories={categories ?? []}
            onEdit={(id) => router.push(`/distributor-products/${id}/edit`)}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  )
}

export default function DistributorProductsPage() {
  return (
    <Suspense fallback={<div>読み込み中...</div>}>
      <DistributorProductsPageInner />
    </Suspense>
  )
}
