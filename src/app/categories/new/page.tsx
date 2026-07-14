'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { CategoryInput } from '@/types/category'
import { CategoryForm } from '@/components/categories/CategoryForm'

export default function NewCategoryPage() {
  const router = useRouter()
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function handleSubmit(data: CategoryInput) {
    setSubmitError(null)
    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setSubmitError(body.error ?? '登録に失敗しました')
        return
      }

      router.push('/categories')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '登録に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/categories" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; カテゴリ一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">カテゴリ登録</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        <CategoryForm onSubmit={handleSubmit} submitLabel="登録" submitError={submitError} />
      </div>
    </div>
  )
}
