'use client'

import { forwardRef, useEffect, useImperativeHandle, useState, type FormEvent } from 'react'
import type { Category } from '@/types/category'
import type { Product } from '@/types/product'

type CompatFormProps = {
  categories: Category[]
  isAdmin: boolean
  onSuccess: () => void
  // WHY: 一覧が全体0件のとき、CompatList側の空状態にも「＋互換品を追加」導線が
  // 表示される（SPEC UI要件）。CompatForm自身が閉じた状態で常に持つ同名トグル
  // ボタンをそのまま両方表示すると同一テキスト・ロールのボタンが重複描画されてしまう
  // ため、CompatList側に導線を譲る場面ではこちらのトグルボタンを非表示にする。
  // フォーム自体（isOpen=trueの中身）の表示・機能には影響しない。
  hideTrigger?: boolean
}

// WHY: CompatList側の「＋互換品を追加」導線（全体0件かつ管理者の空状態）から、
// このフォーム自身が内部で持つ開閉状態(isOpen)を外部から開けるようにするための
// 最小限の命令的ハンドル。isOpenをprops化して制御コンポーネント化すると
// 既存の単体テスト（CompatFormを単独でuncontrolledに使う前提）が壊れるため、
// 通常のprops APIは変えずrefのみで開閉操作を追加する。
export type CompatFormHandle = {
  open: () => void
}

const NOTE_MAX_LENGTH = 500

function productLabel(product: Product) {
  return `${product.name}（JAN: ${product.jan}、メーカー: ${product.maker ?? '不明'}）`
}

export const CompatForm = forwardRef<CompatFormHandle, CompatFormProps>(function CompatForm(
  { categories, isAdmin, onSuccess, hideTrigger },
  ref
) {
  const [isOpen, setIsOpen] = useState(false)
  const [categoryId, setCategoryId] = useState('')
  const [productId1, setProductId1] = useState('')
  const [productId2, setProductId2] = useState('')
  const [note, setNote] = useState('')
  const [productsInCategory, setProductsInCategory] = useState<Product[]>([])
  const [isLoadingProducts, setIsLoadingProducts] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    open: () => setIsOpen(true),
  }))

  // WHY: カテゴリが変わるたびに、そのカテゴリに属するdistributor_products経由の製品候補を取得し直す。
  // 未選択（categoryId===''）のときは空にしてSelectをdisabledにする。
  useEffect(() => {
    if (!categoryId) {
      return
    }
    let cancelled = false
    async function loadProducts() {
      setIsLoadingProducts(true)
      try {
        const res = await fetch(`/api/compat/products?categoryId=${categoryId}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (!cancelled) setProductsInCategory(data.products ?? [])
      } catch {
        if (!cancelled) setError('製品候補の取得に失敗しました')
      } finally {
        if (!cancelled) setIsLoadingProducts(false)
      }
    }
    loadProducts()
    return () => { cancelled = true }
  }, [categoryId])

  function resetForm() {
    setCategoryId('')
    setProductId1('')
    setProductId2('')
    setNote('')
    setProductsInCategory([])
    setError(null)
  }

  function handleToggle() {
    if (isOpen) {
      resetForm()
    }
    setIsOpen((prev) => !prev)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (productId1 === productId2) {
      setError('同じ製品同士は選択できません')
      return
    }

    setIsSubmitting(true)
    try {
      const res = await fetch('/api/compat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId,
          productId1,
          productId2,
          note: note.trim() === '' ? null : note,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? '登録に失敗しました')
        return
      }
      resetForm()
      setIsOpen(false)
      onSuccess()
    } catch {
      setError('登録に失敗しました')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isAdmin) return null

  if (!isOpen) {
    if (hideTrigger) return null
    return (
      <div className="mb-6">
        <button
          type="button"
          onClick={handleToggle}
          className="px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ backgroundColor: '#FF5F03', fontFamily: 'var(--font-ubuntu), sans-serif', borderRadius: '2px' }}
        >
          ＋互換品を追加
        </button>
      </div>
    )
  }

  const productAOptions = productsInCategory.filter((p) => p.id !== productId2)
  const productBOptions = productsInCategory.filter((p) => p.id !== productId1)

  return (
    <div className="mb-6 rounded bg-white shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
      {error && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="compat-categoryId" className="block text-sm font-medium text-gray-700">
            カテゴリ
          </label>
          <select
            id="compat-categoryId"
            value={categoryId}
            onChange={(e) => { setCategoryId(e.target.value); setProductId1(''); setProductId2(''); setProductsInCategory([]) }}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">選択してください</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="compat-productId1" className="block text-sm font-medium text-gray-700">
            製品A
          </label>
          <div className="flex items-center gap-2">
            <select
              id="compat-productId1"
              value={productId1}
              disabled={!categoryId || isLoadingProducts}
              onChange={(e) => {
                const value = e.target.value
                setProductId1(value)
                if (value && value === productId2) setProductId2('')
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!categoryId ? (
                <option value="">先にカテゴリを選択してください</option>
              ) : (
                <>
                  <option value="">選択してください</option>
                  {productAOptions.map((p) => (
                    <option key={p.id} value={p.id}>{productLabel(p)}</option>
                  ))}
                </>
              )}
            </select>
            {isLoadingProducts && (
              <span data-testid="compat-form-products-loading" className="text-xs" style={{ color: '#6B7280' }}>
                読み込み中...
              </span>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="compat-productId2" className="block text-sm font-medium text-gray-700">
            製品B
          </label>
          <div className="flex items-center gap-2">
            <select
              id="compat-productId2"
              value={productId2}
              disabled={!categoryId || isLoadingProducts}
              onChange={(e) => setProductId2(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!categoryId ? (
                <option value="">先にカテゴリを選択してください</option>
              ) : (
                <>
                  <option value="">選択してください</option>
                  {productBOptions.map((p) => (
                    <option key={p.id} value={p.id}>{productLabel(p)}</option>
                  ))}
                </>
              )}
            </select>
            {isLoadingProducts && (
              <span className="text-xs" style={{ color: '#6B7280' }}>
                読み込み中...
              </span>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="compat-note" className="block text-sm font-medium text-gray-700">
            備考
          </label>
          <textarea
            id="compat-note"
            value={note}
            maxLength={NOTE_MAX_LENGTH}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!categoryId || !productId1 || !productId2 || isSubmitting}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? '送信中...' : '登録'}
          </button>
          <button
            type="button"
            onClick={handleToggle}
            className="rounded-md border px-4 py-2 text-sm"
            style={{ borderColor: '#E5E7EB', color: '#6B7280' }}
          >
            キャンセル
          </button>
        </div>
      </form>
    </div>
  )
})
