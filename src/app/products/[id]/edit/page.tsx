'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Product, ProductInput } from '@/types/product'
import { ProductForm } from '@/components/products/ProductForm'

export default function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const [product, setProduct] = useState<Product | null>(null)

  useEffect(() => {
    async function fetchProduct() {
      const res = await fetch(`/api/products/${id}`)
      if (!res.ok) {
        alert('製品が見つかりません')
        router.push('/products')
        return
      }
      const data = await res.json()
      setProduct(data.product)
    }
    fetchProduct()
  }, [id, router])

  async function handleSubmit(data: ProductInput) {
    const res = await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json()
      alert(body.error ?? '更新に失敗しました')
      return
    }

    router.push('/products')
  }

  if (!product) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    )
  }

  const defaultValues: ProductInput = {
    name: product.name,
    code: product.code,
    category: product.category,
    unit: product.unit,
    unitPrice: product.unitPrice,
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link
        href="/products"
        className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800"
      >
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">製品編集</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        <ProductForm
          defaultValues={defaultValues}
          onSubmit={handleSubmit}
          submitLabel="更新"
        />
      </div>
    </div>
  )
}
