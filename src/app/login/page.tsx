'use client'

import { useState, Suspense, FormEvent, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

function LoginForm() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')

  useEffect(() => {
    const hash = window.location.hash
    if (hash.includes('access_token=')) {
      const params = new URLSearchParams(hash.slice(1))
      const access_token = params.get('access_token')
      const refresh_token = params.get('refresh_token')
      if (access_token && refresh_token) {
        const supabase = createSupabaseBrowserClient()
        supabase.auth.setSession({ access_token, refresh_token }).then(({ error }) => {
          if (!error) window.location.href = '/'
        })
      }
    }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/auth/callback`,
      },
    })

    setLoading(false)
    if (signInError) {
      setError('メールの送信に失敗しました。メールアドレスを確認してください。')
      return
    }
    setSent(true)
  }

  async function handleGoogleLogin() {
    setError(null)
    const supabase = createSupabaseBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/auth/callback`,
      },
    })

    if (signInError) {
      setError('Googleログインに失敗しました。もう一度お試しください。')
    }
    // 成功時はSupabaseがGoogleの認証画面へリダイレクトするため、ここでの遷移処理は不要
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }}>
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold mb-4" style={{ color: '#072C2C' }}>
            メールを送信しました
          </h1>
          <p className="text-gray-600">
            <strong>{email}</strong> にログインリンクを送信しました。<br />
            メールを確認してリンクをクリックしてください。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }}>
      <div className="bg-white rounded-lg shadow p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-6 text-center" style={{ color: '#072C2C' }}>
          Medical Inventory
        </h1>
        {(urlError || error) && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error ?? '認証に失敗しました。もう一度お試しください。'}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
              placeholder="example@example.com"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 rounded text-white text-sm font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#072C2C' }}
          >
            {loading ? '送信中...' : 'ログインリンクを送信'}
          </button>
        </form>

        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs text-gray-400">または</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <button
          type="button"
          onClick={handleGoogleLogin}
          className="w-full py-2 px-4 rounded border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
        >
          Googleでログイン
        </button>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }} />
      }
    >
      <LoginForm />
    </Suspense>
  )
}
