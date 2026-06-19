import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FacilityForm } from '../FacilityForm'

describe('FacilityForm', () => {
  it('フォーム送信で onSubmit が正しい値で呼ばれる', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<FacilityForm onSubmit={onSubmit} submitLabel="登録" />)
    await userEvent.type(screen.getByLabelText('施設名'), '中央病院')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: '中央病院' })
  })

  it('施設名が空のとき送信されない（HTML5 required バリデーション）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<FacilityForm onSubmit={onSubmit} submitLabel="登録" />)
    await userEvent.click(screen.getByRole('button', { name: '登録' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
