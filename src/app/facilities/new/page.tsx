'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { FacilityInput } from '@/types/facility'
import { FacilityForm } from '@/components/facilities/FacilityForm'

export default function NewFacilityPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(data: FacilityInput) {
    setError(null)
    try {
      const res = await fetch('/api/facilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        if (res.status === 409) {
          setError('施設名は既に使用されています')
          return
        }
        const body = await res.json()
        setError(body.error ?? '登録に失敗しました')
        return
      }

      router.push('/facilities')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/facilities" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">施設登録</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        {error && <p className="mb-4 text-red-600">{error}</p>}
        <FacilityForm onSubmit={handleSubmit} submitLabel="登録" />
      </div>
    </div>
  )
}
