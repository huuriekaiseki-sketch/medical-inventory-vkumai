'use client'

import { useState, type FormEvent } from 'react'
import type { Product } from '@/types/product'
import type { Category } from '@/types/category'
import type { DistributorProductInput } from '@/types/distributorProduct'

type DistributorProductFormProps = {
  products: Product[]
  categories: Category[]
  defaultValues?: DistributorProductInput
  onSubmit: (data: DistributorProductInput) => Promise<void>
  submitLabel?: string
  submitError?: string | null
}

export function DistributorProductForm({
  products,
  categories,
  defaultValues,
  onSubmit,
  submitLabel = '保存',
  submitError,
}: DistributorProductFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noProducts = products.length === 0
  const noCategories = categories.length === 0
  const submitDisabled = noProducts || noCategories || isSubmitting

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    setError(null)
    setIsSubmitting(true)
    try {
      const reimbursementRaw = formData.get('reimbursementPrice')
      await onSubmit({
        productId: (formData.get('productId') as string) ?? '',
        maker: (formData.get('maker') as string) ?? '',
        supplier: (formData.get('supplier') as string) ?? '',
        name: (formData.get('name') as string) ?? '',
        categoryId: (formData.get('categoryId') as string) ?? '',
        reimbursementPrice: reimbursementRaw !== '' && reimbursementRaw !== null ? Number(reimbursementRaw) : null,
        quantity: Number(formData.get('quantity')),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    } finally {
      setIsSubmitting(false)
    }
  }

  const displayError = submitError ?? error

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {displayError && (
        <p role="alert" className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {displayError}
        </p>
      )}

      <div>
        <label htmlFor="productId" className="block text-sm font-medium text-gray-700">
          商品（JAN / REF）
        </label>
        {noProducts ? (
          <p className="mt-1 text-sm text-gray-700">
            商品が登録されていません。
            <a href="/products" className="text-blue-600 hover:text-blue-800">
              先に商品を登録してください
            </a>
          </p>
        ) : (
          <select
            id="productId"
            name="productId"
            required
            defaultValue={defaultValues?.productId ?? ''}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>
              選択してください
            </option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {`${product.jan} / ${product.ref}`}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label htmlFor="maker" className="block text-sm font-medium text-gray-700">
          メーカー
        </label>
        <input
          id="maker"
          name="maker"
          type="text"
          required
          defaultValue={defaultValues?.maker ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="supplier" className="block text-sm font-medium text-gray-700">
          仕入先
        </label>
        <input
          id="supplier"
          name="supplier"
          type="text"
          required
          defaultValue={defaultValues?.supplier ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">
          商品名
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues?.name ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="categoryId" className="block text-sm font-medium text-gray-700">
          カテゴリ
        </label>
        {noCategories ? (
          <p className="mt-1 text-sm text-gray-700">
            カテゴリが登録されていません。先にカテゴリを登録してください。
          </p>
        ) : (
          <select
            id="categoryId"
            name="categoryId"
            required
            defaultValue={defaultValues?.categoryId ?? ''}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>
              選択してください
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label htmlFor="reimbursementPrice" className="block text-sm font-medium text-gray-700">
          償還価格（円）
        </label>
        <input
          id="reimbursementPrice"
          name="reimbursementPrice"
          type="number"
          min="0"
          step="1"
          defaultValue={defaultValues?.reimbursementPrice ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="quantity" className="block text-sm font-medium text-gray-700">
          入数
        </label>
        <input
          id="quantity"
          name="quantity"
          type="number"
          min="1"
          step="1"
          required
          defaultValue={defaultValues?.quantity ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={submitDisabled}
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? '送信中...' : submitLabel}
      </button>
    </form>
  )
}
