import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LoginPage from '../page'

// createSupabaseBrowserClient をモック
const mockSignInWithOtp = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
    },
  })),
}))

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // NEXT_PUBLIC_SITE_URL 環境変数のセット
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000'
  })

  describe('初期レンダリング', () => {
    it('メールアドレス入力フォームが表示される', () => {
      render(<LoginPage />)
      expect(screen.getByLabelText('メールアドレス')).toBeInTheDocument()
    })

    it('送信ボタンが表示される', () => {
      render(<LoginPage />)
      expect(screen.getByRole('button', { name: 'ログインリンクを送信' })).toBeInTheDocument()
    })

    it('タイトル「Medical Inventory」が表示される', () => {
      render(<LoginPage />)
      expect(screen.getByText('Medical Inventory')).toBeInTheDocument()
    })

    it('初期状態でエラーメッセージは表示されない', () => {
      render(<LoginPage />)
      expect(screen.queryByText('メールの送信に失敗しました。メールアドレスを確認してください。')).not.toBeInTheDocument()
    })
  })

  describe('フォーム送信（成功）', () => {
    it('成功時に「メールを送信しました」画面に切り替わる', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null })

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'test@example.com')

      const button = screen.getByRole('button', { name: 'ログインリンクを送信' })
      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.getByText('メールを送信しました')).toBeInTheDocument()
      })
    })

    it('成功時にメールアドレスが確認画面に表示される', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null })

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'test@example.com')

      fireEvent.click(screen.getByRole('button', { name: 'ログインリンクを送信' }))

      await waitFor(() => {
        expect(screen.getByText('test@example.com')).toBeInTheDocument()
      })
    })

    it('signInWithOtp が正しい引数で呼ばれる', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: null })

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'TEST@EXAMPLE.COM')

      fireEvent.click(screen.getByRole('button', { name: 'ログインリンクを送信' }))

      await waitFor(() => {
        expect(mockSignInWithOtp).toHaveBeenCalledWith({
          email: 'test@example.com', // toLowerCase() されること
          options: {
            emailRedirectTo: 'http://localhost:3000/auth/callback',
          },
        })
      })
    })
  })

  describe('フォーム送信（失敗）', () => {
    it('エラー時にエラーメッセージが表示される', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: new Error('auth error') })

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'test@example.com')

      fireEvent.click(screen.getByRole('button', { name: 'ログインリンクを送信' }))

      await waitFor(() => {
        expect(screen.getByText('メールの送信に失敗しました。メールアドレスを確認してください。')).toBeInTheDocument()
      })
    })

    it('エラー時に「メールを送信しました」画面に切り替わらない', async () => {
      mockSignInWithOtp.mockResolvedValueOnce({ error: new Error('auth error') })

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'test@example.com')

      fireEvent.click(screen.getByRole('button', { name: 'ログインリンクを送信' }))

      await waitFor(() => {
        expect(screen.queryByText('メールを送信しました')).not.toBeInTheDocument()
      })
    })
  })

  describe('ローディング状態', () => {
    it('送信中はボタンが無効化される', async () => {
      // signInWithOtp が resolve するまで pending にする
      let resolve: (value: { error: null }) => void
      mockSignInWithOtp.mockReturnValueOnce(
        new Promise<{ error: null }>((r) => { resolve = r })
      )

      render(<LoginPage />)

      const input = screen.getByLabelText('メールアドレス')
      await userEvent.type(input, 'test@example.com')

      const button = screen.getByRole('button', { name: 'ログインリンクを送信' })
      fireEvent.click(button)

      // 送信中
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '送信中...' })).toBeDisabled()
      })

      // 完了させる
      resolve!({ error: null })
    })
  })
})
