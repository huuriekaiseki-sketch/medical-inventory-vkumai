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
    // WHY: DELETE完了をawaitで待ってから再取得しないと、削除前のデータが再描画され不整合が起きるため
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json()
      alert(body.error ?? '削除に失敗しました')
      return
    }
    refresh()
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

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <ProductList
          products={products}
          onEdit={(id) => router.push(`/products/${id}/edit`)}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
