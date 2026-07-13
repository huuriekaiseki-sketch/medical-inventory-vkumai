'use client'

import { useEffect, useState, useReducer } from 'react'
import { useRouter } from 'next/navigation'
import type { Category } from '@/types/category'
import { CategoryList } from '@/components/categories/CategoryList'

export default function CategoriesPage() {
  const router = useRouter()
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/categories')
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) setCategories(d.categories) })
      .catch(() => { if (!cancelled) setError('カテゴリの取得に失敗しました') })
    return () => { cancelled = true }
  }, [refreshKey])

  async function handleDelete(id: string) {
    if (!confirm('削除しますか？')) return
    setError(null)
    try {
      const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? '削除に失敗しました')
        return
      }
      refresh()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-end justify-between border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
            Category Management
          </p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            カテゴリ
          </h1>
        </div>
        <button
          onClick={() => router.push('/categories/new')}
          className="px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ backgroundColor: '#FF5F03', fontFamily: 'var(--font-ubuntu), sans-serif', borderRadius: '2px' }}
        >
          + 新規登録
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <CategoryList
          categories={categories}
          onEdit={(id) => router.push(`/categories/${id}/edit`)}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
