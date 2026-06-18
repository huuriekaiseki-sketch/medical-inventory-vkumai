'use client'

import { useEffect, useState, useReducer } from 'react'
import { useRouter } from 'next/navigation'
import type { Product } from '@/types/product'
import { ProductList } from '@/components/products/ProductList'

export default function ProductsPage() {
  const router = useRouter()
  const [products, setProducts] = useState<Product[]>([])
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setProducts(d.products) })
    return () => { cancelled = true }
  }, [refreshKey])

  async function handleDelete(id: string) {
    if (!confirm('削除しますか？')) return
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json()
      alert(body.error ?? '削除に失敗しました')
    }
    refresh()
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">製品マスタ</h1>
        <button
          onClick={() => router.push('/products/new')}
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          新規登録
        </button>
      </div>

      <div className="rounded-lg bg-white shadow">
        <ProductList
          products={products}
          onEdit={(id) => router.push(`/products/${id}/edit`)}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
