'use client'

import { useEffect, useRef, useState, useReducer } from 'react'
import type { Category } from '@/types/category'
import type { ProductCompatibility } from '@/types/compatibility'
import { CompatList } from '@/components/compat/CompatList'
import { CompatForm, type CompatFormHandle } from '@/components/compat/CompatForm'

// WHY: このページは useSearchParams() を使わずコンポーネント内 state だけで
// フィルタを保持する設計（SPEC Part2 Set F）。URL連動フィルタは今回スコープ外なので
// <Suspense> ラップは不要。
export default function CompatPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [compatibilities, setCompatibilities] = useState<ProductCompatibility[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)
  const formRef = useRef<CompatFormHandle>(null)

  // 初回: カテゴリ一覧とAdmin判定を取得する。
  // Admin判定は既存 /api/facilities のGETレスポンス（{ facilities, isAdmin }）の
  // isAdmin判定パターンをそのまま踏襲する（news/page.tsx と同型）。
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [categoriesRes, facilitiesRes] = await Promise.all([
          fetch('/api/categories'),
          fetch('/api/facilities'),
        ])
        if (!categoriesRes.ok || !facilitiesRes.ok) throw new Error()
        const categoriesData = await categoriesRes.json()
        const facilitiesData = await facilitiesRes.json()
        if (cancelled) return
        setCategories(categoriesData.categories ?? [])
        setIsAdmin(Boolean(facilitiesData.isAdmin))
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // categoryId・keyword・refreshKey が変わるたびに一覧を再取得する
  useEffect(() => {
    let cancelled = false
    async function loadList() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        if (categoryId) params.set('categoryId', categoryId)
        if (keyword) params.set('keyword', keyword)
        const query = params.toString()
        const res = await fetch(`/api/compat${query ? `?${query}` : ''}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setCompatibilities(data.compatibilities ?? [])
      } catch {
        if (!cancelled) setError('互換品の取得に失敗しました')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadList()
    return () => { cancelled = true }
  }, [categoryId, keyword, refreshKey])

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/compat/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        if (res.status === 404) {
          setError('すでに削除されています')
          refresh()
          return
        }
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? '削除に失敗しました')
        return
      }
      setError(null)
      refresh()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const hasFilter = Boolean(categoryId) || Boolean(keyword)

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Compatibility
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          コンパチ
        </h1>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded px-4 py-3 text-sm font-medium text-white" style={{ backgroundColor: '#DC2626', borderRadius: '2px' }}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="compat-category-filter" className="block text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }}>
            カテゴリで絞り込み
          </label>
          <select
            id="compat-category-filter"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
            style={{ borderColor: '#072C2C33', color: '#072C2C' }}
          >
            <option value="">すべて</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="compat-keyword-filter" className="block text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }}>
            キーワード検索
          </label>
          <input
            id="compat-keyword-filter"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="製品名・JAN・メーカー名で検索"
            className="w-full rounded border px-3 py-2 text-sm"
            style={{ borderColor: '#072C2C33', color: '#072C2C' }}
          />
        </div>
      </div>

      {isAdmin && (
        <CompatForm
          ref={formRef}
          categories={categories}
          isAdmin={isAdmin}
          onSuccess={refresh}
          hideTrigger={compatibilities.length === 0}
        />
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <CompatList
          items={compatibilities}
          isAdmin={isAdmin}
          onDelete={handleDelete}
          hasFilter={hasFilter}
          isLoading={isLoading}
          onAddClick={() => formRef.current?.open()}
        />
      </div>
    </div>
  )
}
