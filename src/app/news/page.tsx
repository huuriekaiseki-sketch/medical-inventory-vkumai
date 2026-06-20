export default function NewsPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Information
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          ニュース
        </h1>
      </div>

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="mb-4 w-12 h-px" style={{ backgroundColor: '#FF5F03' }} />
          <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>
            Coming Soon
          </p>
          <p className="mt-2 text-xs" style={{ color: '#9CA3AF' }}>このページは現在開発中です</p>
        </div>
      </div>
    </div>
  )
}
