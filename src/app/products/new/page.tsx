'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { ProductInput } from '@/types/product'
import { ProductForm } from '@/components/products/ProductForm'

export default function NewProductPage() {
  const router = useRouter()

  async function handleSubmit(data: ProductInput) {
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const body = await res.json()
        alert(body.error ?? '登録に失敗しました')
        return
      }

      router.push('/products')
    } catch (err) {
      alert(err instanceof Error ? err.message : '登録に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/products" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">製品登録</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        <ProductForm onSubmit={handleSubmit} submitLabel="登録" />
      </div>
    </div>
  )
}
