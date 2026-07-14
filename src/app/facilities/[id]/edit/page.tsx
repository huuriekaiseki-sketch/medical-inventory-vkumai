'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Facility, FacilityInput } from '@/types/facility'
import { FacilityForm } from '@/components/facilities/FacilityForm'

export default function EditFacilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [facility, setFacility] = useState<Facility | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/facilities/${id}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setFacility(d.facility) })
      .catch(() => { if (!cancelled) setError('施設の取得に失敗しました') })
    return () => { cancelled = true }
  }, [id])

  async function handleSubmit(data: FacilityInput) {
    setError(null)
    try {
      const res = await fetch(`/api/facilities/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        if (res.status === 409) {
          setError('施設名は既に使用されています')
          return
        }
        const body = await res.json()
        setError(body.error ?? '更新に失敗しました')
        return
      }

      router.push('/facilities')
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました')
    }
  }

  if (error && !facility) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-red-600">{error}</p>
      </div>
    )
  }

  if (!facility) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/facilities" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">施設編集</h1>
      <div className="rounded-lg bg-white p-6 shadow">
        {error && <p className="mb-4 text-red-600">{error}</p>}
        <FacilityForm
          defaultValues={{ name: facility.name }}
          onSubmit={handleSubmit}
          submitLabel="更新"
        />
      </div>
    </div>
  )
}
