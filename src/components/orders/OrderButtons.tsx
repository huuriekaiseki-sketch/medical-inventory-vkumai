'use client'

import Link from 'next/link'
import type { FacilityRole } from '@/types/role'

type Props = {
  facilityId: string
  // WHY: undefinedは取得中(プレースホルダ表示でレイアウトシフトを防ぐ)。
  //      viewer/nullは書き込み不可のためボタンを出さない(issue #608)。
  role: FacilityRole | null | undefined
}

export function OrderButtons({ facilityId, role }: Props) {
  const base = `/facilities/${facilityId}`
  const btnBase = 'px-4 py-2 text-sm font-semibold rounded text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-block'

  if (role === undefined) {
    return <div className="mb-8 h-[42px]" aria-hidden="true" />
  }

  // WHY(issue #803 決定8=(a)): ロット検索はviewerにも許可する読み取り専用機能。
  // 書き込み可否(canWrite)とは別に「施設のメンバーかどうか」で出し分ける
  // (未所属nullは対象外。APIもrequireFacilityAccessで403にするため見せても無意味)
  const isMember = role !== null
  const lotSearchLink = isMember ? (
    <Link href={`${base}/lot-search`} className={btnBase} style={{ backgroundColor: '#7C3AED' }}>
      ロット検索
    </Link>
  ) : null

  const canWrite = role === 'admin' || role === 'staff'
  if (!canWrite) {
    return (
      <div className="mb-8">
        <div
          className="rounded px-4 py-3 text-sm"
          style={{ backgroundColor: '#F3F4F6', color: '#4B5563', border: '1px solid #E5E7EB' }}
        >
          閲覧のみの権限のため、発注・返却はできません。
        </div>
        {lotSearchLink && <div className="mt-3 flex flex-wrap gap-3">{lotSearchLink}</div>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-3 mb-8">
      <Link href={`${base}/case-orders`} className={btnBase} style={{ backgroundColor: '#B03F00' }}>
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
      {lotSearchLink}
    </div>
  )
}
