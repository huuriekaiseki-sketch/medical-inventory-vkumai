import type { PriceHistory } from '@/types/priceHistory'
import { FIELD_LABEL, ENTITY_LABEL } from '@/types/priceHistory'

function formatPrice(value: number | null): string {
  if (value === null) return '—'
  return `¥${value.toLocaleString('ja-JP')}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function entityLabel(item: PriceHistory): string {
  if (item.entityType === 'distributor_product') return ENTITY_LABEL.distributor_product
  const name = item.facilityName ?? '施設情報なし'
  return `施設価格（${name}）`
}

interface Props {
  item: PriceHistory
  isOpen: boolean
  onToggle: () => void
}

export function PriceHistoryRow({ item, isOpen, onToggle }: Props) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-gray-50"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
          {formatDate(item.changedAt)}
        </td>
        <td className="px-4 py-3 text-sm text-gray-900">
          {entityLabel(item)}
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          {item.entityType === 'hospital_price' ? FIELD_LABEL[item.fieldName] : '—'}
        </td>
        <td className="px-4 py-3 text-sm text-gray-900 text-right">
          {formatPrice(item.oldValue)}
        </td>
        <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
          {formatPrice(item.newValue)}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-gray-50">
          <td colSpan={5} className="px-6 py-4">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <dt className="text-gray-500">種別</dt>
              <dd className="text-gray-900">{ENTITY_LABEL[item.entityType]}</dd>
              <dt className="text-gray-500">履歴 ID</dt>
              <dd className="font-mono text-xs text-gray-700 break-all">{item.id}</dd>
              <dt className="text-gray-500">レコード ID</dt>
              <dd className="font-mono text-xs text-gray-700 break-all">{item.entityId}</dd>
              {item.entityType === 'hospital_price' && (
                <>
                  <dt className="text-gray-500">施設名</dt>
                  <dd className="text-gray-900">{item.facilityName ?? '施設情報なし'}</dd>
                </>
              )}
              <dt className="text-gray-500">フィールド</dt>
              <dd className="text-gray-900">{FIELD_LABEL[item.fieldName]}</dd>
              <dt className="text-gray-500">変更前</dt>
              <dd className="text-gray-900">{formatPrice(item.oldValue)}</dd>
              <dt className="text-gray-500">変更後</dt>
              <dd className="font-medium text-gray-900">{formatPrice(item.newValue)}</dd>
              <dt className="text-gray-500">変更日時</dt>
              <dd className="text-gray-900">{formatDate(item.changedAt)}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}
