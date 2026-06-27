import Link from 'next/link'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div
        className="px-6 py-3 text-sm flex items-center gap-4"
        style={{ backgroundColor: '#072C2C', color: 'white' }}
      >
        <span className="font-semibold">管理画面</span>
        <Link href="/" className="text-white/70 hover:text-white text-xs">
          ← トップに戻る
        </Link>
      </div>
      <div className="max-w-5xl mx-auto px-6 py-8">{children}</div>
    </div>
  )
}
