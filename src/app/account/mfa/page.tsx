'use client'

import { useEffect, useState, FormEvent } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

type EnrollState =
  | { status: 'loading' }
  | { status: 'verified'; factorId: string }
  | { status: 'not-enrolled' }
  | {
      status: 'enrolling'
      factorId: string
      qrCode: string
      secret: string
    }

export default function MfaSettingsPage() {
  const [state, setState] = useState<EnrollState>({ status: 'loading' })
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    const supabase = createSupabaseBrowserClient()
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      if (cancelled) return
      if (listError) {
        setError('MFA設定の取得に失敗しました。')
        setState({ status: 'not-enrolled' })
        return
      }
      const verified = data.totp.find(f => f.status === 'verified')
      setState(verified ? { status: 'verified', factorId: verified.id } : { status: 'not-enrolled' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleEnroll() {
    setError(null)
    const supabase = createSupabaseBrowserClient()
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    if (enrollError || !data) {
      setError('MFAの登録開始に失敗しました。')
      return
    }
    setState({
      status: 'enrolling',
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    })
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault()
    if (state.status !== 'enrolling') return
    setSubmitting(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: state.factorId,
    })
    if (challengeError || !challengeData) {
      setSubmitting(false)
      setError('確認コードの検証に失敗しました。')
      return
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: state.factorId,
      challengeId: challengeData.id,
      code,
    })

    setSubmitting(false)
    if (verifyError) {
      setError('コードが正しくありません。もう一度お試しください。')
      return
    }
    setCode('')
    setState({ status: 'verified', factorId: state.factorId })
  }

  async function handleUnenroll() {
    if (state.status !== 'verified') return
    setSubmitting(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: state.factorId })

    setSubmitting(false)
    if (unenrollError) {
      setError('MFAの解除に失敗しました。')
      return
    }
    setState({ status: 'not-enrolled' })
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Account Settings
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          二段階認証(MFA)
        </h1>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="rounded bg-white shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        {state.status === 'loading' && <p className="text-sm text-gray-500">読み込み中...</p>}

        {state.status === 'not-enrolled' && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              二段階認証は現在無効です。認証アプリ(Google Authenticator等)を使って有効化できます。
            </p>
            <button
              type="button"
              onClick={handleEnroll}
              className="py-2 px-4 rounded text-white text-sm font-medium"
              style={{ backgroundColor: '#072C2C' }}
            >
              二段階認証を有効化する
            </button>
          </>
        )}

        {state.status === 'enrolling' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-sm text-gray-600">
              認証アプリでQRコードを読み取り、表示された6桁のコードを入力してください。
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element -- Supabaseが実行時に返すSVG data URIで、next/imageの最適化対象にできないため */}
            <img src={state.qrCode} alt="MFA QRコード" className="w-40 h-40" />
            <p className="text-xs text-gray-400 break-all">シークレットキー: {state.secret}</p>
            <div>
              <label htmlFor="mfa-code" className="block text-sm font-medium text-gray-700 mb-1">
                確認コード
              </label>
              <input
                id="mfa-code"
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
              className="py-2 px-4 rounded text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: '#072C2C' }}
            >
              {submitting ? '検証中...' : '確認して有効化'}
            </button>
          </form>
        )}

        {state.status === 'verified' && (
          <>
            <p className="text-sm text-green-700 mb-4">✓ 二段階認証は有効です。</p>
            <button
              type="button"
              onClick={handleUnenroll}
              disabled={submitting}
              className="py-2 px-4 rounded border border-red-300 text-red-700 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? '解除中...' : '二段階認証を解除する'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
