import Link from 'next/link'
import type { UnifiedOrder, OrdersFetchError } from '@/types/order'
import { OrderKindBadge } from './OrderKindBadge'

// WHY: 生statusのラベル変換。4テーブルで許容値が異なる（case/consumable/loan: draft/submitted、
// loan_return: draft/returned）ため、和名対応表は横断的にここで一元管理する
const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済み',
  returned: '返却済み',
}

function formatDatetime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP')
}

type Props = {
  orders: UnifiedOrder[]
  errors: OrdersFetchError[]
  loading: boolean
  showFacilityColumn: boolean
  getDetailHref: (order: UnifiedOrder) => string
}

export function OrderHistoryTable({ orders, errors, loading, showFacilityColumn, getDetailHref }: Props) {
  const colCount = 5 + (showFacilityColumn ? 1 : 0)

  return (
    <div>
      {errors.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded px-4 py-3 text-sm text-white"
          style={{ backgroundColor: '#D97706' }}
        >
          一部の発注種別を取得できませんでした
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">発注日時</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">種別</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">ステータス</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">製品名</th>
              {showFacilityColumn && (
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">施設名</th>
              )}
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr data-testid="order-history-skeleton">
                <td colSpan={colCount} className="px-6 py-8 text-center text-sm text-gray-500">
                  読み込み中...
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-6 py-8 text-center text-sm text-gray-500">
                  該当する発注履歴がありません
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={`${order.kind}-${order.id}`}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatDatetime(order.displayDatetime)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <OrderKindBadge kind={order.kind} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {STATUS_LABEL[order.status] ?? order.status}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">{order.summaryLabel}</td>
                  {showFacilityColumn && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {order.facilityName ?? '-'}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <Link href={getDetailHref(order)} className="text-indigo-600 hover:text-indigo-900 font-medium">
                      詳細
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
