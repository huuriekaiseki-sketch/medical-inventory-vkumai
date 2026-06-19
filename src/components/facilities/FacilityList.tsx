'use client'

import type { Facility } from '@/types/facility'

type FacilityListProps = {
  facilities: Facility[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function FacilityList({ facilities, onEdit, onDelete }: FacilityListProps) {
  if (facilities.length === 0) {
    return (
      <p className="text-center text-gray-500 py-8">
        施設が登録されていません
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">施設名</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">登録日</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {facilities.map((facility) => (
            <tr key={facility.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{facility.name}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                {new Date(facility.createdAt).toLocaleDateString('ja-JP')}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                <button
                  onClick={() => onEdit(facility.id)}
                  className="text-indigo-600 hover:text-indigo-900 font-medium"
                >
                  編集
                </button>
                <button
                  onClick={() => onDelete(facility.id)}
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
