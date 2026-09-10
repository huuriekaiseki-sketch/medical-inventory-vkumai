'use client'

import { useState } from 'react'

type Props = {
  facilityId: string
  onRegister: (facilityId: string, name: string) => Promise<void>
}

/**
 * 消耗品の登録フォーム。名前を入れて「登録」を押すと在庫に 1 件足す。
 */
export function ConsumableRegisterForm({ facilityId, onRegister }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      await onRegister(facilityId, name)
      setName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <label htmlFor="consumable-name" className="block text-sm font-medium">
        品目名
      </label>
      <input
        id="consumable-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="w-full rounded border px-2 py-1"
        required
      />
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-white">
        登録
      </button>
    </form>
  )
}
