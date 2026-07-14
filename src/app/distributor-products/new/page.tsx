'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Product } from '@/types/product'
import type { Category } from '@/types/category'
import type { DistributorProductInput } from '@/types/distributorProduct'
import { DistributorProductForm } from '@/components/distributor-products/DistributorProductForm'

export default function NewDistributorProductPage() {
  const router = useRouter()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/products').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/categories').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
    ]).then(([productsData, categoriesData]) => {
      if (cancelled) return
      setProducts(productsData.products)
      setCategories(categoriesData.categories)
    }).catch(() => {
      if (!cancelled) setLoadError('データの取得に失敗しました')
    })
    return () => { cancelled = true }
  }, [])

  async function handleSubmit(data: DistributorProductInput) {
    setSubmitError(null)
    try {
      const res = await fetch('/api/distributor-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setSubmitError(body.error ?? '登録に失敗しました')
        return
      }

      router.push('/distributor-products')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '登録に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/distributor-products" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">販売店商品登録</h1>
      {loadError && <p className="mb-4 text-red-600">{loadError}</p>}
      <div className="rounded-lg bg-white p-6 shadow">
        <DistributorProductForm
          products={products}
          categories={categories}
          onSubmit={handleSubmit}
          submitLabel="登録"
          submitError={submitError}
        />
      </div>
    </div>
  )
}
