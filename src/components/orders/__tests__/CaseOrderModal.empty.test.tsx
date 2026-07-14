import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CaseOrderModal } from '../CaseOrderModal'

describe('CaseOrderModal 空送信防止', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'co-1' } }),
    })
  })

  it('全フィールド空のまま送信するとfetchが呼ばれずエラーが表示される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(await screen.findByText('症例日時を入力してください')).toBeInTheDocument()
  })

  it('手技名以外の必須項目（患者ID等）が空のまま送信するとfetchが呼ばれずエラーが表示される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'カテーテル手技')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(await screen.findByText('症例日時を入力してください')).toBeInTheDocument()
  })

  it('症例日時のみ入力し患者IDが空のまま送信するとfetchが呼ばれず患者ID未入力のエラーが表示される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('症例日時 *'), '2026-07-13T10:00')
    await userEvent.type(screen.getByLabelText(/手技名/), 'カテーテル手技')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(await screen.findByText('患者IDを入力してください')).toBeInTheDocument()
  })

  it('患者ID・患者イニシャルまで入力し担当医師が空のまま送信するとfetchが呼ばれず担当医師未入力のエラーが表示される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('症例日時 *'), '2026-07-13T10:00')
    await userEvent.type(screen.getByLabelText(/手技名/), 'カテーテル手技')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P-001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'AB')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(await screen.findByText('担当医師を入力してください')).toBeInTheDocument()
  })

  it('全必須項目を入力すればfetchが呼ばれる', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('症例日時 *'), '2026-07-13T10:00')
    await userEvent.type(screen.getByLabelText(/手技名/), 'カテーテル手技')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P-001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'AB')
    await userEvent.type(screen.getByLabelText(/担当医師/), '山田太郎')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalled()
  })
})
