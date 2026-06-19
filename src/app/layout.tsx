import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Medical Inventory",
  description: "医療在庫管理システム",
};

const navLinks = [
  { href: '/products', label: '製品マスタ' },
  { href: '/facilities', label: '施設管理' },
  { href: '/hospital-prices', label: '施設別価格' },
]

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-gray-50">
        <header className="bg-slate-800 text-white">
          <nav className="mx-auto flex max-w-5xl items-center gap-8 px-4 py-3">
            <Link href="/" className="text-lg font-bold tracking-wide">
              Medical Inventory
            </Link>
            {navLinks.map(({ href, label }) => (
              <Link key={href} href={href} className="text-sm text-slate-300 hover:text-white">
                {label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
