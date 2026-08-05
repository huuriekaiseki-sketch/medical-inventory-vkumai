import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LogoutButton } from '../LogoutButton'

const mockSignOut = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      signOut: mockSignOut,
    },
  })),
}))

const mockPush = vi.fn()
const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    refresh: mockRefresh,
  })),
}))

describe('LogoutButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSignOut.mockResolvedValue({ error: null })
  })

  it('「ログアウト」ボタンが表示される', () => {
    render(<LogoutButton />)
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument()
  })

  it('クリックするとsignOutが呼ばれ、/loginへ遷移する', async () => {
    const user = userEvent.setup()
    render(<LogoutButton />)

    await user.click(screen.getByRole('button', { name: 'ログアウト' }))

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1)
    })
    expect(mockPush).toHaveBeenCalledWith('/login')
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('signOut処理中はボタンが「ログアウト中...」表示になり無効化される', async () => {
    let resolveSignOut: (value: { error: null }) => void = () => {}
    mockSignOut.mockReturnValue(
      new Promise((resolve) => {
        resolveSignOut = resolve
      })
    )
    const user = userEvent.setup()
    render(<LogoutButton />)

    await user.click(screen.getByRole('button', { name: 'ログアウト' }))

    const button = screen.getByRole('button', { name: 'ログアウト中...' })
    expect(button).toBeDisabled()

    resolveSignOut({ error: null })
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/login')
    })
  })
})
