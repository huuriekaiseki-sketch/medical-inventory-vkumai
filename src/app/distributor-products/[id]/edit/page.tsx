'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Product } from '@/types/product'
import type { Category } from '@/types/category'
import type { DistributorProduct, DistributorProductInput } from '@/types/distributorProduct'
import { DistributorProductForm } from '@/components/distributor-products/DistributorProductForm'

export default function EditDistributorProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [item, setItem] = useState<DistributorProduct | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/distributor-products/${id}`).then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/products').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/categories').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
    ]).then(([dpData, productsData, categoriesData]) => {
      if (cancelled) return
      if (!dpData.item) {
        setLoadError('販売店商品の取得に失敗しました')
        return
      }
      setItem(dpData.item)
      setProducts(productsData.products)
      setCategories(categoriesData.categories)
    }).catch(() => {
      if (!cancelled) setLoadError('販売店商品の取得に失敗しました')
    })
    return () => { cancelled = true }
  }, [id])

  async function handleSubmit(data: DistributorProductInput) {
    setSubmitError(null)
    try {
      const res = await fetch(`/api/distributor-products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setSubmitError(body.error ?? '更新に失敗しました')
        return
      }

      router.push('/distributor-products')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '更新に失敗しました')
    }
  }

  if (loadError && !item) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-red-600">{loadError}</p>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/distributor-products" className="text-sm text-blue-600 hover:text-blue-800">
          &larr; 一覧に戻る
        </Link>
        <Link href={`/distributor-products/${id}/price-history`} className="text-sm text-blue-600 hover:text-blue-800">
          価格履歴を見る →
        </Link>
      </div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">販売店商品編集</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        <DistributorProductForm
          products={products}
          categories={categories}
          defaultValues={{
            productId: item.productId,
            maker: item.maker,
            supplier: item.supplier,
            name: item.name,
            reimbursementPrice: item.reimbursementPrice,
            quantity: item.quantity,
            categoryId: item.categoryId,
          }}
          onSubmit={handleSubmit}
          submitLabel="更新"
          submitError={submitError}
        />
      </div>
    </div>
  )
}
