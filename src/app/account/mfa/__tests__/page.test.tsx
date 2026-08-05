import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MfaSettingsPage from '../page'

const mockListFactors = vi.fn()
const mockEnroll = vi.fn()
const mockChallenge = vi.fn()
const mockVerify = vi.fn()
const mockUnenroll = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      mfa: {
        listFactors: mockListFactors,
        enroll: mockEnroll,
        challenge: mockChallenge,
        verify: mockVerify,
        unenroll: mockUnenroll,
      },
    },
  })),
}))

describe('MfaSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('MFA未登録の場合、有効化ボタンが表示される', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null })

    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を有効化する' })).toBeInTheDocument()
    })
  })

  it('検証済みfactorがある場合、有効状態と解除ボタンが表示される', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })

    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('✓ 二段階認証は有効です。')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '二段階認証を解除する' })).toBeInTheDocument()
  })

  it('有効化ボタンをクリックするとenrollが呼ばれQRコードが表示される', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null })
    mockEnroll.mockResolvedValueOnce({
      data: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;base64,xxx', secret: 'SECRET123' } },
      error: null,
    })

    const user = userEvent.setup()
    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を有効化する' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '二段階認証を有効化する' }))

    await waitFor(() => {
      expect(screen.getByAltText('MFA QRコード')).toBeInTheDocument()
    })
    expect(screen.getByText(/SECRET123/)).toBeInTheDocument()
  })

  it('確認コードを入力してverifyが成功すると有効状態に切り替わる', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null })
    mockEnroll.mockResolvedValueOnce({
      data: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;base64,xxx', secret: 'SECRET123' } },
      error: null,
    })
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null })
    mockVerify.mockResolvedValueOnce({ error: null })

    const user = userEvent.setup()
    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を有効化する' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '二段階認証を有効化する' }))

    await waitFor(() => {
      expect(screen.getByLabelText('確認コード')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('確認コード'), '123456')
    await user.click(screen.getByRole('button', { name: '確認して有効化' }))

    await waitFor(() => {
      expect(screen.getByText('✓ 二段階認証は有効です。')).toBeInTheDocument()
    })
    expect(mockVerify).toHaveBeenCalledWith({
      factorId: 'new-factor',
      challengeId: 'challenge-1',
      code: '123456',
    })
  })

  it('確認コードが誤っている場合エラーメッセージが表示される', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null })
    mockEnroll.mockResolvedValueOnce({
      data: { id: 'new-factor', totp: { qr_code: 'data:image/svg+xml;base64,xxx', secret: 'SECRET123' } },
      error: null,
    })
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null })
    mockVerify.mockResolvedValueOnce({ error: new Error('invalid code') })

    const user = userEvent.setup()
    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を有効化する' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '二段階認証を有効化する' }))

    await waitFor(() => {
      expect(screen.getByLabelText('確認コード')).toBeInTheDocument()
    })
    await user.type(screen.getByLabelText('確認コード'), '000000')
    await user.click(screen.getByRole('button', { name: '確認して有効化' }))

    await waitFor(() => {
      expect(screen.getByText('コードが正しくありません。もう一度お試しください。')).toBeInTheDocument()
    })
  })

  it('解除ボタンをクリックするとunenrollが呼ばれ未登録状態に戻る', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    })
    mockUnenroll.mockResolvedValueOnce({ error: null })

    const user = userEvent.setup()
    render(<MfaSettingsPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を解除する' })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: '二段階認証を解除する' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '二段階認証を有効化する' })).toBeInTheDocument()
    })
    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' })
  })
})
