'use client'

import { useState } from 'react'
import type { PriceHistory } from '@/types/priceHistory'
import { PriceHistoryRow } from './PriceHistoryRow'

interface Props {
  items: PriceHistory[]
}

export function PriceHistoryList({ items }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)

  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">変更履歴はありません</p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              日時
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              種別
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              フィールド
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              変更前
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              変更後
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {items.map((item) => (
            <PriceHistoryRow
              key={item.id}
              item={item}
              isOpen={openId === item.id}
              onToggle={() => setOpenId(openId === item.id ? null : item.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
