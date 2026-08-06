'use client'

import React, { useState } from 'react'
import type { AdminUser, Facility } from '@/types/admin'
import { FACILITY_ROLES, type FacilityRole } from '@/types/role'

type Props = {
  users: AdminUser[]
  facilities: Facility[]
  onToggleFacility: (userId: string, facilityId: string, add: boolean) => void
  onDeleteUser: (userId: string, email: string) => void
  onChangeRole: (userId: string, facilityId: string, role: FacilityRole) => void
}

export function UserTable({ users, facilities, onToggleFacility, onDeleteUser, onChangeRole }: Props) {
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr style={{ borderBottom: '2px solid #072C2C' }}>
          <th className="text-left py-2 px-3">メール</th>
          <th className="text-left py-2 px-3">最終ログイン</th>
          <th className="text-left py-2 px-3">担当施設</th>
          <th className="py-2 px-3"></th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <React.Fragment key={user.id}>
            <tr style={{ borderBottom: '1px solid #ccc' }}>
              <td className="py-2 px-3">{user.email}</td>
              <td className="py-2 px-3">
                {user.lastSignInAt
                  ? new Date(user.lastSignInAt).toLocaleDateString('ja-JP')
                  : '未ログイン'}
              </td>
              <td className="py-2 px-3">
                <button
                  className="text-xs underline"
                  onClick={() =>
                    setExpandedUserId(expandedUserId === user.id ? null : user.id)
                  }
                >
                  ▼ 展開して設定
                </button>
              </td>
              <td className="py-2 px-3">
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={() => onDeleteUser(user.id, user.email)}
                >
                  削除
                </button>
              </td>
            </tr>
            {expandedUserId === user.id && (
              <tr>
                <td colSpan={4} className="px-6 py-2 bg-white">
                  <div className="flex flex-wrap gap-4">
                    {facilities.map((f) => {
                      const assigned = user.facilities.find((uf) => uf.id === f.id)
                      return (
                        <div key={f.id} className="flex items-center gap-2 text-sm">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              aria-label={f.name}
                              checked={user.facilities.some((uf) => uf.id === f.id)}
                              onChange={(e) =>
                                onToggleFacility(user.id, f.id, e.target.checked)
                              }
                            />
                            {f.name}
                          </label>
                          {assigned && (
                            <select
                              aria-label={`${f.name}のrole`}
                              value={assigned.role}
                              onChange={(e) =>
                                onChangeRole(user.id, f.id, e.target.value as FacilityRole)
                              }
                              className="text-xs border rounded px-1"
                            >
                              {FACILITY_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  )
}
