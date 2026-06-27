'use client'

import { useEffect, useState, useCallback } from 'react'
import { UserTable } from '@/components/admin/UserTable'
import { InviteModal } from '@/components/admin/InviteModal'
import type { AdminUser } from '@/types/admin'

type Facility = { id: string; name: string }

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [inviteOpen, setInviteOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const loadUsers = useCallback(async () => {
    const [usersRes, facilitiesRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/facilities'),
    ])
    const { users } = await usersRes.json()
    const { facilities } = await facilitiesRes.json()
    setUsers(users)
    setFacilities(facilities)
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const handleToggleFacility = async (userId: string, facilityId: string, add: boolean) => {
    await fetch('/api/admin/user-facilities', {
      method: add ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, facilityId }),
    })
    setUsers(prev =>
      prev.map(u =>
        u.id !== userId ? u : {
          ...u,
          facilityIds: add
            ? [...u.facilityIds, facilityId]
            : u.facilityIds.filter(id => id !== facilityId),
        }
      )
    )
  }

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!confirm(`${email} を削除しますか？`)) return
    await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    setUsers(prev => prev.filter(u => u.id !== userId))
    showToast('ユーザーを削除しました')
  }

  const handleInvite = async (email: string) => {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    setInviteOpen(false)
    if (res.ok) {
      showToast(`${email} に招待メールを送信しました`)
      await loadUsers()
    } else {
      const { error } = await res.json()
      showToast(`エラー: ${error}`)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">ユーザー管理</h1>
        <button
          onClick={() => setInviteOpen(true)}
          className="px-4 py-2 text-sm text-white rounded"
          style={{ backgroundColor: '#072C2C' }}
        >
          + 招待
        </button>
      </div>

      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={handleToggleFacility}
        onDeleteUser={handleDeleteUser}
      />

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvite={handleInvite}
      />

      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-800 text-white px-4 py-2 rounded shadow text-sm">
          {toast}
        </div>
      )}
    </div>
  )
}
