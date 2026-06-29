'use client'

import Link from 'next/link'

type Props = {
  facilityId: string
}

export function OrderButtons({ facilityId }: Props) {
  const base = `/facilities/${facilityId}`
  const btnBase = 'px-4 py-2 text-sm font-semibold rounded text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-block'

  return (
    <div className="flex flex-wrap gap-3 mb-8">
      <Link href={`${base}/case-orders`} className={btnBase} style={{ backgroundColor: '#FF5F03' }}>
        症例発注
      </Link>
      <Link href={`${base}/consumable-orders`} className={btnBase} style={{ backgroundColor: '#16A34A' }}>
        消耗品発注
      </Link>
      <Link href={`${base}/loan-orders`} className={btnBase} style={{ backgroundColor: '#2563EB' }}>
        短貸発注
      </Link>
      <Link href={`${base}/loan-returns`} className={btnBase} style={{ backgroundColor: '#4B5563' }}>
        短貸返却
      </Link>
      <button
        type="button"
        className={btnBase}
        style={{ backgroundColor: '#9CA3AF' }}
        disabled
      >
        長貸し処理
      </button>
    </div>
  )
}
