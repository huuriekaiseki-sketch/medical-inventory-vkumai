import Link from 'next/link'

// WHY: /admin 直アクセスが404になっていた（layout.tsxとusers/reportsはあるのに
// インデックスページが無い、issue #645）。admin配下の機能一覧への入口として
// /other ページと同じ静的リンクカードのパターンで用意する。
// 認可はmiddleware（/adminちょうども対象のadminガード）に委ねるため、
// このページ自体に認可チェックは持たない。
export default function AdminIndexPage() {
  return (
    <div>
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Admin
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          管理画面
        </h1>
      </div>

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-6 py-4" style={{ borderBottom: '1px solid #E5E7EB' }}>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }}>
            ユーザー
          </p>
          <Link
            href="/admin/users"
            className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
            style={{ color: '#072C2C' }}
          >
            ユーザー管理（招待・権限変更）
          </Link>
        </div>
        <div className="px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }}>
            レポート
          </p>
          <Link
            href="/admin/reports"
            className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
            style={{ color: '#072C2C' }}
          >
            発注金額レポート
          </Link>
        </div>
      </div>
    </div>
  )
}
