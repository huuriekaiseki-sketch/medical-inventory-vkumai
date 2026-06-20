'use client'

import { useState, type FormEvent } from 'react'
import type { CategoryInput } from '@/types/category'

type CategoryFormProps = {
  defaultValues?: CategoryInput
  onSubmit: (data: CategoryInput) => Promise<void>
  submitLabel?: string
  submitError?: string | null
}

export function CategoryForm({ defaultValues, onSubmit, submitLabel = '保存', submitError }: CategoryFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const formData = new FormData(e.currentTarget)
    const rawName = formData.get('name')
    const name = (rawName !== null ? rawName as string : '').trim()
    if (!name) {
      setError('カテゴリ名を入力してください')
      return
    }
    const rawDescription = formData.get('description')
    const trimmedDescription = (rawDescription !== null ? rawDescription as string : '').trim()
    const description = trimmedDescription === '' ? null : trimmedDescription

    setIsSubmitting(true)
    try {
      await onSubmit({ name, description })
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {(submitError ?? error) && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {submitError ?? error}
        </div>
      )}

      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">
          カテゴリ名
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues?.name ?? ''}
          placeholder="消耗品"
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium text-gray-700">
          説明
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={defaultValues?.description ?? ''}
          placeholder="任意"
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? '送信中...' : submitLabel}
      </button>
    </form>
  )
}
