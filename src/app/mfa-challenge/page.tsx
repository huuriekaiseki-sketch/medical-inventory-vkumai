'use client'

import { useEffect, useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export default function MfaChallengePage() {
  const router = useRouter()
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const supabase = createSupabaseBrowserClient()

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (cancelled) return
      if (aal && aal.currentLevel === aal.nextLevel) {
        // 既にaal2達成済み(このページに来る必要がない)ならトップへ戻す
        router.push('/')
        return
      }

      const { data, error: listError } = await supabase.auth.mfa.listFactors()
      if (cancelled) return
      if (listError) {
        setError('MFA情報の取得に失敗しました。')
        setLoading(false)
        return
      }
      const verified = data.totp.find(f => f.status === 'verified')
      if (!verified) {
        setError('有効な二段階認証が見つかりませんでした。')
        setLoading(false)
        return
      }
      setFactorId(verified.id)
      setLoading(false)
    }

    init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- マウント時に1回だけ実行する初期化処理
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setSubmitting(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    })
    if (challengeError || !challengeData) {
      setSubmitting(false)
      setError('確認コードの送信に失敗しました。')
      return
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code,
    })

    setSubmitting(false)
    if (verifyError) {
      setError('コードが正しくありません。もう一度お試しください。')
      return
    }

    router.push('/')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }}>
      <div className="bg-white rounded-lg shadow p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-6 text-center" style={{ color: '#072C2C' }}>
          二段階認証
        </h1>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        {loading && <p className="text-sm text-gray-500 text-center">読み込み中...</p>}

        {!loading && factorId && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="mfa-challenge-code" className="block text-sm font-medium text-gray-700 mb-1">
                認証アプリの確認コード
              </label>
              <input
                id="mfa-challenge-code"
                type="text"
                inputMode="numeric"
                required
                value={code}
                onChange={e => setCode(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                placeholder="123456"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 px-4 rounded text-white text-sm font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: '#072C2C' }}
            >
              {submitting ? '検証中...' : '確認する'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
