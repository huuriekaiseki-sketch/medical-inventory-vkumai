'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { Facility } from '@/types/facility'

export default function FacilityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [facility, setFacility] = useState<Facility | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/facilities/${id}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) setFacility(d.facility) })
      .catch(() => { if (!cancelled) setError('施設の取得に失敗しました') })
    return () => { cancelled = true }
  }, [id])

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center gap-3 rounded px-4 py-3 text-sm font-medium text-white" style={{ backgroundColor: '#DC2626', borderRadius: '2px' }}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
        <Link href="/facilities" className="mt-4 inline-block text-sm hover:underline" style={{ color: '#072C2C' }}>
          ← 施設一覧に戻る
        </Link>
      </div>
    )
  }

  if (!facility) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href="/facilities" className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Facility Detail
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          {facility.name}
        </h1>
      </div>

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <table className="min-w-full">
          <tbody>
            <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                施設名
              </th>
              <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>
                {facility.name}
              </td>
            </tr>
            <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                登録日
              </th>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(facility.createdAt).toLocaleDateString('ja-JP')}
              </td>
            </tr>
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                更新日
              </th>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(facility.updatedAt).toLocaleDateString('ja-JP')}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
