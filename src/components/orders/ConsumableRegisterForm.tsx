'use client'

import { useState } from 'react'
import type {
  Consumable,
  ConsumablesApiErrorResponse,
  ConsumablesApiPostRequest,
  ConsumablesApiPostResponse,
} from '@/types/order'

type Props = {
  facilityId: string
  onRegistered: (consumable: Consumable) => void
}

/**
 * 消耗品登録フォーム(issue #647 Set A)
 * 品名(必須)・JAN(任意)・用途(必須)を入力し POST /api/consumables を呼ぶ。
 *
 * 受け入れ条件「品名・用途が空白のみの場合は400エラーになる」は、API側
 * (`src/app/api/consumables/route.ts`)が実際にバリデーションし400を返すことで
 * 満たしている(route.test.tsでカバー)。ここでのUI側チェックは、その400が
 * 発生する条件を先取りして即座にフィードバックするためのUX上の追加であり、
 * サーバー側バリデーションを置き換えるものではない(不正なAPI直叩きは
 * 引き続き400になる)。
 */
export function ConsumableRegisterForm({ facilityId, onRegistered }: Props) {
  const [name, setName] = useState('')
  const [jan, setJan] = useState('')
  const [purpose, setPurpose] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
  const inputStyle = { borderColor: '#E5E7EB' }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedName = name.trim()
    const trimmedPurpose = purpose.trim()

    if (!trimmedName) {
      setError('品名を入力してください')
      return
    }
    if (!trimmedPurpose) {
      setError('用途を入力してください')
      return
    }

    const trimmedJan = jan.trim()
    const payload: ConsumablesApiPostRequest = {
      facilityId,
      name: trimmedName,
      purpose: trimmedPurpose,
      ...(trimmedJan ? { jan: trimmedJan } : {}),
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/consumables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d: ConsumablesApiErrorResponse = await res.json()
        throw new Error(d.error || '登録に失敗しました')
      }
      const d: ConsumablesApiPostResponse = await res.json()
      onRegistered(d.consumable)
      setName('')
      setJan('')
      setPurpose('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
      {error && (
        <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div>
          <label htmlFor="consumable-name" className={labelClass} style={labelStyle}>品名</label>
          <input
            id="consumable-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-full"
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="consumable-jan" className={labelClass} style={labelStyle}>JAN</label>
          <input
            id="consumable-jan"
            type="text"
            value={jan}
            onChange={e => setJan(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-full"
            style={{ ...inputStyle, fontFamily: 'var(--font-ubuntu-mono), monospace' }}
          />
        </div>
        <div>
          <label htmlFor="consumable-purpose" className={labelClass} style={labelStyle}>用途</label>
          <input
            id="consumable-purpose"
            type="text"
            value={purpose}
            onChange={e => setPurpose(e.target.value)}
            className="border rounded px-3 py-2 text-sm w-full"
            style={inputStyle}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#16A34A' }}
        >
          {submitting ? '登録中...' : '登録する'}
        </button>
      </div>
    </form>
  )
}
