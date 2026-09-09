'use client'

import { useState } from 'react'
import type { Consumable, ConsumablesApiErrorResponse } from '@/types/order'

type Props = {
  facilityId: string
  consumables: Consumable[]
  /** 書き込み UI を出すか（viewer には出さない）。押せないボタンを見せない */
  canWrite: boolean
  onChanged: () => void
}

/**
 * 登録済みの消耗品の一覧と、直す・止める・消す道（2026-09-09）。
 *
 * WHY(直す道が無かった): 消耗品は**作成と一覧しかできなかった**。打ち間違えた名前は直せず、
 *      廃番になっても発注の選択肢に残り続けた。DB は施設の writer に UPDATE / DELETE を
 *      許していたので、**層の食い違い**（E-055 の裏返し）だった。
 *
 * WHY(削除と使用停止を出し分ける): 発注で使われたものを消すと過去の発注から品目が消える。
 *      サーバーは使われていれば 409 で拒むが、**押してから断られるのは道が無いのと同じ**なので、
 *      一覧が持っている `inUse` でボタンの側を変える（判定の正本はサーバー）。
 */
export function ConsumableList({ facilityId, consumables, canWrite, onChanged }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [jan, setJan] = useState('')
  const [purpose, setPurpose] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const startEdit = (c: Consumable) => {
    setError(null)
    setEditingId(c.id)
    setName(c.name)
    setJan(c.jan ?? '')
    setPurpose(c.purpose)
  }

  /** 応答の中身からエラー文言を取り出す。取り出せなければ渡された既定を使う */
  const failureMessage = async (res: Response, fallback: string) => {
    try {
      const d: ConsumablesApiErrorResponse = await res.json()
      return d.error || fallback
    } catch {
      return fallback
    }
  }

  const submitEdit = async (id: string) => {
    const trimmedName = name.trim()
    const trimmedPurpose = purpose.trim()
    if (!trimmedName) return setError('品名を入力してください')
    if (!trimmedPurpose) return setError('用途を入力してください')

    const trimmedJan = jan.trim()
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/consumables/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          name: trimmedName,
          purpose: trimmedPurpose,
          ...(trimmedJan ? { jan: trimmedJan } : {}),
        }),
      })
      if (!res.ok) throw new Error(await failureMessage(res, '更新に失敗しました'))
      setEditingId(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  const retire = async (c: Consumable) => {
    // WHY(確かめる): 使用停止は戻せない（DB のトリガーが `retired` からの遷移を拒む）
    if (!window.confirm(`「${c.name}」を使用停止にしますか？（戻せません）`)) return
    setBusyId(c.id)
    setError(null)
    try {
      const res = await fetch(`/api/consumables/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId, action: 'retire' }),
      })
      if (!res.ok) throw new Error(await failureMessage(res, '使用停止に失敗しました'))
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '使用停止に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (c: Consumable) => {
    // WHY(確かめる): 行ごと消えるので取り消せない
    if (!window.confirm(`「${c.name}」を削除しますか？（元に戻せません）`)) return
    setBusyId(c.id)
    setError(null)
    try {
      const res = await fetch(`/api/consumables/${c.id}?facilityId=${encodeURIComponent(facilityId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await failureMessage(res, '削除に失敗しました'))
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setBusyId(null)
    }
  }

  const inputStyle = { borderColor: '#E5E7EB' }
  const actionClass = 'text-xs font-semibold px-2 py-1 rounded border hover:opacity-80 disabled:opacity-50'

  if (consumables.length === 0) {
    return <p className="text-sm" style={{ color: '#4B5563' }}>消耗品が登録されていません。</p>
  }

  return (
    <>
      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}
      <ul className="rounded bg-white shadow-sm divide-y" style={{ border: '1px solid #E5E7EB' }}>
        {consumables.map(c => (
          <li key={c.id} className="px-4 py-3 text-sm" style={{ color: '#111827' }} data-testid={`consumable-${c.id}`}>
            {editingId === c.id ? (
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-center">
                <input
                  aria-label="品名"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="border rounded px-2 py-1 text-sm"
                  style={inputStyle}
                />
                <input
                  aria-label="JAN"
                  value={jan}
                  onChange={e => setJan(e.target.value)}
                  className="border rounded px-2 py-1 text-sm"
                  style={{ ...inputStyle, fontFamily: 'var(--font-ubuntu-mono), monospace' }}
                />
                <input
                  aria-label="用途"
                  value={purpose}
                  onChange={e => setPurpose(e.target.value)}
                  className="border rounded px-2 py-1 text-sm"
                  style={inputStyle}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => submitEdit(c.id)}
                    disabled={busyId === c.id}
                    className={actionClass}
                    style={{ borderColor: '#16A34A', color: '#15803D' }}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingId(null); setError(null) }}
                    className={actionClass}
                    style={{ borderColor: '#E5E7EB', color: '#4B5563' }}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span style={c.status === 'retired' ? { color: '#6B7280', textDecoration: 'line-through' } : undefined}>
                  {c.name}
                </span>
                {c.jan && (
                  <span className="text-xs" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{c.jan}</span>
                )}
                <span className="text-xs px-1 rounded" style={{ backgroundColor: '#F3F4F6', color: '#4B5563' }}>{c.purpose}</span>
                {c.status === 'retired' && (
                  <span className="text-xs px-1 rounded" style={{ backgroundColor: '#FEE2E2', color: '#B91C1C' }}>使用停止</span>
                )}
                {canWrite && c.status === 'active' && (
                  <div className="flex gap-2 ml-auto">
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      className={actionClass}
                      style={{ borderColor: '#E5E7EB', color: '#4B5563' }}
                    >
                      編集
                    </button>
                    {/* WHY: 発注で使われていれば消せない。押せないボタンを見せるより、意味のある方だけを出す */}
                    {c.inUse ? (
                      <button
                        type="button"
                        onClick={() => retire(c)}
                        disabled={busyId === c.id}
                        className={actionClass}
                        style={{ borderColor: '#B45309', color: '#B45309' }}
                      >
                        使用停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => remove(c)}
                        disabled={busyId === c.id}
                        className={actionClass}
                        style={{ borderColor: '#DC2626', color: '#B91C1C' }}
                      >
                        削除
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
