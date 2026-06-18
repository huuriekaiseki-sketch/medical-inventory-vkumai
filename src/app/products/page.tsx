'use client'

import { useEffect, useState, useReducer } from 'react'
import { useRouter } from 'next/navigation'
import type { Product } from '@/types/product'
import { ProductList } from '@/components/products/ProductList'
import { DeleteConfirmDialog } from '@/components/products/DeleteConfirmDialog'

export default function ProductsPage() {
  const router = useRouter()
  const [products, setProducts] = useState<Product[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res = await fetch('/api/products')
      const data = await res.json()
      if (!cancelled) setProducts(data.products)
    }
    load()
    return () => { cancelled = true }
  }, [refreshKey])

  function handleEdit(id: string) {
    router.push(`/products/${id}/edit`)
  }

  function handleDeleteClick(id: string) {
    const product = products.find((p) => p.id === id)
    if (product) setDeleteTarget(product)
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return
    const res = await fetch(`/api/products/${deleteTarget.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json()
      alert(body.error ?? '削除に失敗しました')
    }
    setDeleteTarget(null)
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
          onEdit={handleEdit}
          onDelete={handleDeleteClick}
        />
      </div>

      <DeleteConfirmDialog
        isOpen={deleteTarget !== null}
        productName={deleteTarget?.name ?? ''}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
