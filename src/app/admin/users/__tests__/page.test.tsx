import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AdminUsersPage from '../page'

const users = [
  {
    id: 'u1',
    email: 'user1@example.com',
    lastSignInAt: null,
    facilities: [{ id: 'f1', role: 'staff' as const }],
  },
]

const facilities = [
  { id: 'f1', name: '施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: '施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

// 各テストの共通セットアップ: 初回GETを成功させ、一覧展開まで進める
async function renderExpanded(fetchMock: ReturnType<typeof vi.spyOn>) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ users }) } as Response)
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ facilities }) } as Response)

  render(<AdminUsersPage />)
  await screen.findByText('user1@example.com')

  await userEvent.click(screen.getByText('▼ 展開して設定'))
}

describe('AdminUsersPage エラーハンドリング', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handleToggleFacility: fetch自体が例外を投げた場合エラーを表示する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    await renderExpanded(fetchMock)

    fetchMock.mockRejectedValueOnce(new Error('network error'))

    await userEvent.click(screen.getByRole('checkbox', { name: '施設B' }))

    expect(await screen.findByText('エラー: 通信に失敗しました')).toBeInTheDocument()
  })

  it('handleChangeRole: fetch自体が例外を投げた場合エラーを表示する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    await renderExpanded(fetchMock)

    fetchMock.mockRejectedValueOnce(new Error('network error'))

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '施設Aのrole' }), 'admin')

    expect(await screen.findByText('エラー: 通信に失敗しました')).toBeInTheDocument()
  })

  it('handleDeleteUser: fetch自体が例外を投げた場合エラーを表示する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderExpanded(fetchMock)

    fetchMock.mockRejectedValueOnce(new Error('network error'))

    await userEvent.click(screen.getByText('削除'))

    expect(await screen.findByText('エラー: 通信に失敗しました')).toBeInTheDocument()
  })

  it('handleInvite: fetch自体が例外を投げた場合エラーを表示する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    await renderExpanded(fetchMock)

    fetchMock.mockRejectedValueOnce(new Error('network error'))

    await userEvent.click(screen.getByText('+ 招待'))
    await userEvent.type(screen.getByPlaceholderText('メールアドレス'), 'new-user@example.com')
    await userEvent.click(screen.getByText('招待する'))

    expect(await screen.findByText('エラー: 通信に失敗しました')).toBeInTheDocument()
  })

  it('全ハンドラでfetch成功時は従来通りエラーを表示しない', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    await renderExpanded(fetchMock)

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response)

    await userEvent.click(screen.getByRole('checkbox', { name: '施設B' }))

    await waitFor(() => {
      expect(screen.queryByText('エラー: 通信に失敗しました')).not.toBeInTheDocument()
    })
  })
})
