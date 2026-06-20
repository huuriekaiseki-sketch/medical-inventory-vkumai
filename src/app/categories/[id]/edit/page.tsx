'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Category, CategoryInput } from '@/types/category'
import { CategoryForm } from '@/components/categories/CategoryForm'

export default function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [category, setCategory] = useState<Category | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/categories/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('not found')
        return r.json()
      })
      .then((d) => { if (!cancelled) setCategory(d.category) })
      .catch(() => { if (!cancelled) setFetchError('カテゴリの取得に失敗しました') })
    return () => { cancelled = true }
  }, [id])

  async function handleSubmit(data: CategoryInput) {
    setSubmitError(null)
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setSubmitError(body.error ?? '更新に失敗しました')
      return
    }

    router.push('/categories')
  }

  if (fetchError && !category) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <Link href="/categories" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
          &larr; カテゴリ一覧に戻る
        </Link>
        <p className="text-red-600">{fetchError}</p>
      </div>
    )
  }

  if (!category) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/categories" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; カテゴリ一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">カテゴリ編集</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        <CategoryForm
          defaultValues={{ name: category.name, description: category.description }}
          onSubmit={handleSubmit}
          submitLabel="更新"
          submitError={submitError}
        />
      </div>
    </div>
  )
}
