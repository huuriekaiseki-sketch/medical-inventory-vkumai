'use client'

import { useEffect, useState, useReducer } from 'react'
import { useRouter } from 'next/navigation'
import type { Facility } from '@/types/facility'
import { FacilityList } from '@/components/facilities/FacilityList'

export default function FacilitiesPage() {
  const router = useRouter()
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/facilities')
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) setFacilities(d.facilities) })
      .catch(() => { if (!cancelled) setError('施設の取得に失敗しました') })
    return () => { cancelled = true }
  }, [refreshKey])

  async function handleDelete(id: string) {
    setError(null)
    const res = await fetch(`/api/facilities/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json()
      setError(body.error ?? '削除に失敗しました')
      return
    }
    refresh()
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">施設マスタ</h1>
        <button
          onClick={() => router.push('/facilities/new')}
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          + 新規施設を登録
        </button>
      </div>

      {error && <p className="mb-4 text-red-600">{error}</p>}

      <div className="rounded-lg bg-white shadow">
        <FacilityList
          facilities={facilities}
          onEdit={(id) => router.push(`/facilities/${id}/edit`)}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
