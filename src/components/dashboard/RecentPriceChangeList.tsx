'use client'

import Link from 'next/link'
import type { RecentPriceChange } from '@/types/dashboard'
import { FIELD_LABEL, ENTITY_LABEL } from '@/types/priceHistory'

type RecentPriceChangeListProps = {
  items: RecentPriceChange[]
}

function formatPrice(value: number | null): string {
  if (value === null) return '—'
  return `¥${value.toLocaleString('ja-JP')}`
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RecentPriceChangeList({ items }: RecentPriceChangeListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center rounded bg-white shadow-sm" style={{ border: '1px solid #E5E7EB' }}>
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>データがありません</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded bg-white shadow-sm" style={{ border: '1px solid #E5E7EB' }}>
      <table className="min-w-full">
        <thead>
          <tr style={{ backgroundColor: '#072C2C' }}>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              商品名
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              変更項目
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              変更前
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              変更後
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              変更日時
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr
              key={item.id}
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-4 py-3 text-sm font-medium">
                <Link
                  href={`/distributor-products/${item.distributorProductId}/price-history`}
                  className="hover:underline"
                  style={{ color: '#072C2C' }}
                >
                  {item.productName ?? '商品情報なし'}
                </Link>
              </td>
              <td className="px-4 py-3 text-sm" style={{ color: '#6B7280' }}>
                {item.entityType === 'hospital_price' ? `${ENTITY_LABEL.hospital_price}（${FIELD_LABEL[item.fieldName]}）` : FIELD_LABEL[item.fieldName]}
              </td>
              <td className="px-4 py-3 text-right text-sm" style={{ color: '#374151' }}>
                {formatPrice(item.oldValue)}
              </td>
              <td className="px-4 py-3 text-right text-sm font-semibold" style={{ color: '#111827' }}>
                {formatPrice(item.newValue)}
              </td>
              <td className="px-4 py-3 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {formatDateTime(item.changedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
