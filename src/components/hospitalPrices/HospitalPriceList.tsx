'use client'

import type { HospitalPrice } from '@/types/hospitalPrice'

type HospitalPriceListProps = {
  prices: (HospitalPrice & { facilityName: string; productName: string })[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  // WHY: viewerロールのUIゲーティング(issue #608)。falseの場合、編集/削除操作列を
  // 出さない(実際の書き込み拒否はRLSが最終的に担保するが、viewerには操作不能な
  // ボタンをそもそも見せない)。
  canWrite: boolean
}

function formatRate(rate: number | null): string {
  if (rate == null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

export function HospitalPriceList({ prices, onEdit, onDelete, canWrite }: HospitalPriceListProps) {
  if (prices.length === 0) {
    return (
      <p className="text-center text-gray-500 py-8">
        価格情報が登録されていません
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">施設名</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">商品名</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">仕切値（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">納品価格（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">粗利（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">仕入れ掛け率</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">納入掛け率</th>
            {canWrite && <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {prices.map((price) => (
            <tr key={price.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{price.facilityName}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{price.productName}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.purchasePrice.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.deliveryPrice.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.grossProfit.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatRate(price.purchaseRate)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatRate(price.deliveryRate)}</td>
              {canWrite && (
                <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                  <button
                    onClick={() => onEdit(price.id)}
                    className="text-indigo-600 hover:text-indigo-900 font-medium"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => onDelete(price.id)}
                    className="text-red-600 hover:text-red-900 font-medium"
                  >
                    削除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
