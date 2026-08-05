import type { Metadata } from "next";
import { Ubuntu, Oswald } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { createServerSupabase } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/LogoutButton";

const ubuntu = Ubuntu({
  variable: "--font-ubuntu",
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
});

const oswald = Oswald({
  variable: "--font-oswald",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Medical Inventory",
  description: "医療在庫管理システム",
};

const navLinks = [
  { href: '/facilities', label: '施設一覧' },
  { href: '/products', label: 'デバイス' },
  { href: '/distributor-products', label: '販売店商品' },
  { href: '/orders', label: '発注履歴' },
  { href: '/news', label: 'ニュース' },
  { href: '/compat', label: 'コンパチ' },
  { href: '/other', label: 'その他' },
]

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <html
      lang="ja"
      className={`${ubuntu.variable} ${oswald.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" style={{ backgroundColor: '#EDEADE', fontFamily: 'var(--font-ubuntu), sans-serif', color: '#111827' }}>
        <header style={{ backgroundColor: '#072C2C' }}>
          <nav className="mx-auto flex max-w-6xl items-center gap-0 px-6">
            <Link
              href="/"
              className="py-4 pr-8 text-white tracking-widest uppercase text-sm font-semibold"
              style={{ fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.12em' }}
            >
              Medical Inventory
            </Link>
            <div className="h-6 w-px bg-white/20 mr-4" />
            {navLinks.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="relative px-4 py-4 text-sm font-medium text-white/70 hover:text-white transition-colors duration-150"
                style={{ fontFamily: 'var(--font-ubuntu), sans-serif' }}
              >
                {label}
              </Link>
            ))}
            {user && (
              <>
                <div className="h-6 w-px bg-white/20 mx-2" />
                <LogoutButton />
              </>
            )}
          </nav>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
