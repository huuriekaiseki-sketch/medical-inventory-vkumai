'use client'

import { useState } from 'react'

type Props = {
  open: boolean
  onClose: () => void
  onInvite: (email: string) => void
}

export function InviteModal({ open, onClose, onInvite }: Props) {
  const [email, setEmail] = useState('')

  if (!open) return null

  const handleSubmit = () => {
    if (!email.trim()) return
    onInvite(email.trim())
    setEmail('')
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-80 shadow-xl">
        <h2 className="text-lg font-semibold mb-4">ユーザーを招待</h2>
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm mb-4"
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => { setEmail(''); onClose() }}
            className="px-4 py-2 text-sm rounded border"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm rounded text-white"
            style={{ backgroundColor: '#072C2C' }}
          >
            招待する
          </button>
        </div>
      </div>
    </div>
  )
}
