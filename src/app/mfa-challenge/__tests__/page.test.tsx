import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MfaChallengePage from '../page'

const mockGetAAL = vi.fn()
const mockListFactors = vi.fn()
const mockChallenge = vi.fn()
const mockVerify = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mockGetAAL,
        listFactors: mockListFactors,
        challenge: mockChallenge,
        verify: mockVerify,
      },
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

describe('MfaChallengePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('既にaal2の場合はトップへリダイレクトする', async () => {
    mockGetAAL.mockResolvedValueOnce({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    })

    render(<MfaChallengePage />)

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/')
    })
  })

  it('aal1→aal2が必要な場合、確認コード入力フォームが表示される', async () => {
    mockGetAAL.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })

    render(<MfaChallengePage />)

    await waitFor(() => {
      expect(screen.getByLabelText('認証アプリの確認コード')).toBeInTheDocument()
    })
  })

  it('コードを送信するとchallenge→verifyが呼ばれ成功時にトップへ遷移する', async () => {
    mockGetAAL.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null })
    mockVerify.mockResolvedValueOnce({ error: null })

    const user = userEvent.setup()
    render(<MfaChallengePage />)

    await waitFor(() => {
      expect(screen.getByLabelText('認証アプリの確認コード')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('認証アプリの確認コード'), '123456')
    await user.click(screen.getByRole('button', { name: '確認する' }))

    await waitFor(() => {
      expect(mockVerify).toHaveBeenCalledWith({
        factorId: 'factor-1',
        challengeId: 'challenge-1',
        code: '123456',
      })
    })
    expect(mockPush).toHaveBeenCalledWith('/')
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('コードが誤っている場合エラーメッセージが表示される', async () => {
    mockGetAAL.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null })
    mockVerify.mockResolvedValueOnce({ error: new Error('invalid code') })

    const user = userEvent.setup()
    render(<MfaChallengePage />)

    await waitFor(() => {
      expect(screen.getByLabelText('認証アプリの確認コード')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('認証アプリの確認コード'), '000000')
    await user.click(screen.getByRole('button', { name: '確認する' }))

    await waitFor(() => {
      expect(screen.getByText('コードが正しくありません。もう一度お試しください。')).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalledWith('/')
  })
})
