'use client'

import { useState } from 'react'
import type { Product } from '@/types/product'

type ProductListProps = {
  products: Product[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function ProductList({ products, onEdit, onDelete }: ProductListProps) {
  // WHY: ホバー時の (e.target as HTMLElement).style 直接操作はReactの管理外でDOMを変更し、
  //      再レンダリングで状態が失われるため、useState + className で宣言的に管理する
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>製品が登録されていません</p>
        <p className="mt-1 text-xs" style={{ color: '#9CA3AF' }}>「新規登録」から追加してください</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr style={{ backgroundColor: '#072C2C' }}>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              JAN コード
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              REF コード
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((product, i) => (
            <tr
              key={product.id}
              className="transition-colors duration-100 hover:bg-[#EDEADE]/60"
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {product.jan}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {product.ref}
              </td>
              <td className="px-6 py-4 text-sm">
                <div className="flex items-center gap-3">
                  {(() => {
                    const editKey = `${product.id}-edit`
                    const editHover = hoveredKey === editKey
                    return (
                      <button
                        onClick={() => onEdit(product.id)}
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
                    const delKey = `${product.id}-delete`
                    const delHover = hoveredKey === delKey
                    return (
                      <button
                        onClick={() => onDelete(product.id)}
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
