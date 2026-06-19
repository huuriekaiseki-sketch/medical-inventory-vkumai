'use client'

import { useState, type FormEvent } from 'react'
import type { FacilityInput } from '@/types/facility'

type FacilityFormProps = {
  defaultValues?: FacilityInput
  onSubmit: (data: FacilityInput) => Promise<void>
  submitLabel?: string
}

export function FacilityForm({ defaultValues, onSubmit, submitLabel = '保存' }: FacilityFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const formData = new FormData(e.currentTarget)
    const rawName = formData.get('name')
    const name = (rawName !== null ? rawName as string : '').trim()
    if (!name) {
      setError('施設名を入力してください')
      return
    }
    setIsSubmitting(true)
    try {
      await onSubmit({ name })
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">
          施設名
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={defaultValues?.name ?? ''}
          placeholder="中央病院"
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
