import Link from 'next/link'

export default function OtherPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Settings & More
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          その他
        </h1>
      </div>

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-6 py-4" style={{ borderBottom: '1px solid #E5E7EB' }}>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }}>
            マスタ管理
          </p>
          <Link
            href="/categories"
            className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
            style={{ color: '#072C2C' }}
          >
            カテゴリ管理
          </Link>
        </div>
      </div>
    </div>
  )
}
