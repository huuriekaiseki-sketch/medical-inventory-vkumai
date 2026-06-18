'use client'

import { type FormEvent } from 'react'
import type { ProductInput } from '@/types/product'

type ProductFormProps = {
  defaultValues?: ProductInput
  onSubmit: (data: ProductInput) => void | Promise<void>
  submitLabel?: string
}

const CATEGORY_OPTIONS = ['消耗品', '機器', '試薬'] as const

export function ProductForm({
  defaultValues,
  onSubmit,
  submitLabel = '保存',
}: ProductFormProps) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const formData = new FormData(form)

    const rawPrice = formData.get('unitPrice') as string
    const unitPrice = rawPrice !== '' ? Number(rawPrice) : null

    const data: ProductInput = {
      name: formData.get('name') as string,
      code: formData.get('code') as string,
      category: formData.get('category') as string,
      unit: formData.get('unit') as string,
      unitPrice,
    }

    onSubmit(data)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">
          製品名
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
        <label htmlFor="code" className="block text-sm font-medium text-gray-700">
          製品コード
        </label>
        <input
          id="code"
          name="code"
          type="text"
          required
          defaultValue={defaultValues?.code ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="category" className="block text-sm font-medium text-gray-700">
          カテゴリ
        </label>
        <select
          id="category"
          name="category"
          required
          defaultValue={defaultValues?.category ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="" disabled>
            選択してください
          </option>
          {CATEGORY_OPTIONS.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="unit" className="block text-sm font-medium text-gray-700">
          単位
        </label>
        <input
          id="unit"
          name="unit"
          type="text"
          required
          defaultValue={defaultValues?.unit ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="unitPrice" className="block text-sm font-medium text-gray-700">
          単価
        </label>
        <input
          id="unitPrice"
          name="unitPrice"
          type="number"
          defaultValue={defaultValues?.unitPrice ?? ''}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {submitLabel}
      </button>
    </form>
  )
}
