'use client'

import { useState } from 'react'
import type { DistributorProduct } from '@/types/distributorProduct'
import type { Category } from '@/types/category'

type DistributorProductListProps = {
  items: DistributorProduct[]
  categories: Category[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function DistributorProductList({ items, categories, onEdit, onDelete }: DistributorProductListProps) {
  // WHY: ホバー時のstyle直接操作はReactの管理外DOM変更となり再レンダリングで失われるため、
  //      useState + className による宣言的管理へ置き換える
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>販売店商品が登録されていません</p>
      </div>
    )
  }

  const categoryNameById = new Map(categories.map(c => [c.id, c.name]))

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr style={{ backgroundColor: '#072C2C' }}>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              商品名
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              メーカー
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              仕入先
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              カテゴリ
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              償還価格
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              数量
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr
              key={item.id}
              className="transition-colors duration-100 hover:bg-[#EDEADE]/60"
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>
                {item.name}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>
                {item.maker}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>
                {item.supplier}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>
                {categoryNameById.get(item.categoryId) ?? '—'}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {item.reimbursementPrice === null ? '—' : `¥${item.reimbursementPrice.toLocaleString()}`}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {item.quantity}
              </td>
              <td className="px-6 py-4 text-sm">
                <div className="flex items-center gap-3">
                  {(() => {
                    const editKey = `${item.id}-edit`
                    const editHover = hoveredKey === editKey
                    return (
                      <button
                        onClick={() => onEdit(item.id)}
                        className={`text-xs font-semibold uppercase tracking-wide px-3 py-1.5 transition-colors duration-100 focus:outline-none focus-visible:ring-2${editHover ? ' is-hover' : ''}`}
                        style={{ color: editHover ? '#fff' : '#072C2C', backgroundColor: editHover ? '#072C2C' : 'transparent', border: '1px solid #072C2C', borderRadius: '2px', fontFamily: 'var(--font-oswald), sans-serif' }}
                        onMouseEnter={() => setHoveredKey(editKey)}
                        onMouseLeave={() => setHoveredKey(null)}
                      >
                        編集
                      </button>
                    )
                  })()}
                  {(() => {
                    const delKey = `${item.id}-delete`
                    const delHover = hoveredKey === delKey
                    return (
                      <button
                        onClick={() => onDelete(item.id)}
                        className={`text-xs font-semibold uppercase tracking-wide px-3 py-1.5 transition-colors duration-100 focus:outline-none focus-visible:ring-2${delHover ? ' is-hover' : ''}`}
                        style={{ color: delHover ? '#fff' : '#DC2626', backgroundColor: delHover ? '#DC2626' : 'transparent', border: '1px solid #DC2626', borderRadius: '2px', fontFamily: 'var(--font-oswald), sans-serif' }}
                        onMouseEnter={() => setHoveredKey(delKey)}
                        onMouseLeave={() => setHoveredKey(null)}
                      >
                        削除
                      </button>
                    )
                  })()}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
