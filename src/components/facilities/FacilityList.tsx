'use client'

import Link from 'next/link'
import type { Facility } from '@/types/facility'

type FacilityListProps = {
  facilities: Facility[]
}

export function FacilityList({ facilities }: FacilityListProps) {
  if (facilities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>施設が登録されていません</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr style={{ backgroundColor: '#072C2C' }}>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              施設名
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              登録日
            </th>
          </tr>
        </thead>
        <tbody>
          {facilities.map((facility, i) => (
            <tr
              key={facility.id}
              className="transition-colors duration-100 hover:bg-[#EDEADE]/60"
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-6 py-4 text-sm font-medium">
                <Link
                  href={`/facilities/${facility.id}`}
                  className="hover:underline"
                  style={{ color: '#072C2C' }}
                >
                  {facility.name}
                </Link>
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(facility.createdAt).toLocaleDateString('ja-JP')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
