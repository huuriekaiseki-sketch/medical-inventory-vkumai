'use client'

import type { NewsFeedItem } from '@/types/newsFeedItem'
import { EVENT_TYPE_LABEL } from '@/types/newsFeedItem'
import { FIELD_LABEL } from '@/types/priceHistory'

type NewsFeedListProps = {
  items: NewsFeedItem[]
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

export function NewsFeedList({ items }: NewsFeedListProps) {
  if (items.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center rounded bg-white shadow-sm"
        style={{ border: '1px solid #E5E7EB' }}
      >
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>お知らせはありません</p>
      </div>
    )
  }

  return (
    <ul className="divide-y" style={{ borderColor: '#E5E7EB' }}>
      {items.map((item) => (
        <li key={item.id} className="px-4 py-4 bg-white">
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-xs font-semibold uppercase tracking-widest px-2 py-0.5 rounded"
              style={{
                color: item.eventType === 'new_product' ? '#FF5F03' : '#072C2C',
                fontFamily: 'var(--font-oswald), sans-serif',
              }}
            >
              {EVENT_TYPE_LABEL[item.eventType]}
            </span>
            <span
              className="text-xs"
              style={{ color: '#9CA3AF', fontFamily: 'var(--font-ubuntu-mono), monospace' }}
            >
              {formatDateTime(item.occurredAt)}
            </span>
          </div>
          <p className="text-sm font-medium" style={{ color: '#111827' }}>
            {item.productName}
            <span className="ml-2 text-xs font-normal" style={{ color: '#6B7280' }}>
              {item.maker} / {item.supplier}
            </span>
          </p>
          {item.eventType !== 'new_product' && item.fieldName && (
            <p className="text-sm mt-1" style={{ color: '#374151' }}>
              {FIELD_LABEL[item.fieldName]}: {formatPrice(item.oldValue)} →{' '}
              <span className="font-semibold">{formatPrice(item.newValue)}</span>
              {item.facilityName && (
                <span className="ml-2 text-xs" style={{ color: '#6B7280' }}>
                  （{item.facilityName}）
                </span>
              )}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}
