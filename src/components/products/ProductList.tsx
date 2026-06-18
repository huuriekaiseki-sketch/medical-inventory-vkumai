'use client'

import type { Product } from '@/types/product'

type ProductListProps = {
  products: Product[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function ProductList({ products, onEdit, onDelete }: ProductListProps) {
  if (products.length === 0) {
    return (
      <p className="text-center text-gray-500 py-8">
        製品が登録されていません
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">JAN コード</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">REF コード</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {products.map((product) => (
            <tr key={product.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{product.jan}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{product.ref}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                <button
                  onClick={() => onEdit(product.id)}
                  className="text-indigo-600 hover:text-indigo-900 font-medium"
                >
                  編集
                </button>
                <button
                  onClick={() => onDelete(product.id)}
                  className="text-red-600 hover:text-red-900 font-medium"
                >
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
