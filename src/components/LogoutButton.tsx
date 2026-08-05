'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export function LogoutButton() {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogout() {
    setLoading(true)
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      className="px-4 py-4 text-sm font-medium text-white/70 hover:text-white transition-colors duration-150 disabled:opacity-50"
      style={{ fontFamily: 'var(--font-ubuntu), sans-serif' }}
    >
      {loading ? 'ログアウト中...' : 'ログアウト'}
    </button>
  )
}
