'use client'

import { useEffect, useState } from 'react'
import type { Facility } from '@/types/facility'
import { FacilityList } from '@/components/facilities/FacilityList'

export default function FacilitiesPage() {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/facilities')
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) setFacilities(d.facilities) })
      .catch(() => { if (!cancelled) setError('施設の取得に失敗しました') })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Master Data
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          施設一覧
        </h1>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded px-4 py-3 text-sm font-medium text-white" style={{ backgroundColor: '#DC2626', borderRadius: '2px' }}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <FacilityList facilities={facilities} />
      </div>
    </div>
  )
}
