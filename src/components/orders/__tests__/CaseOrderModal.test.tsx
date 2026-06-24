import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CaseOrderModal } from '../CaseOrderModal'

describe('CaseOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'co-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('症例発注')).not.toBeInTheDocument()
  })

  it('isOpen=trueのときモーダルが表示される', () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByLabelText(/症例日時/)).toBeInTheDocument()
    expect(screen.getByLabelText(/手技名/)).toBeInTheDocument()
    expect(screen.getByLabelText(/患者ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/患者イニシャル/)).toBeInTheDocument()
    expect(screen.getByLabelText(/性別/)).toBeInTheDocument()
    expect(screen.getByLabelText(/担当医師/)).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/case-ordersが呼ばれる', async () => {
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={onClose} onSuccess={onSuccess} />)

    await userEvent.type(screen.getByLabelText(/症例日時/), '2026-06-24T10:00')
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'T.S.')
    await userEvent.type(screen.getByLabelText(/担当医師/), '田中医師')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))

    expect(fetch).toHaveBeenCalledWith('/api/case-orders', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.facilityId).toBe('f-1')
    expect(body.procedureName).toBe('TAVI')
    expect(onSuccess).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('APIエラー時にエラーメッセージが表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: '送信に失敗しました' }),
    })
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument()
  })

  it('性別「女」を選択して送信するとgender:femaleが送信される', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.selectOptions(screen.getByLabelText(/性別/), 'female')
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'T.S.')
    await userEvent.type(screen.getByLabelText(/担当医師/), '田中医師')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.gender).toBe('female')
  })

  it('+ 行を追加で物品行を増やして送信できる', async () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'T.S.')
    await userEvent.type(screen.getByLabelText(/担当医師/), '田中医師')
    await userEvent.click(screen.getByRole('button', { name: '+ 行を追加' }))
    // 2行あることを確認
    const janInputs = screen.getAllByPlaceholderText('JAN')
    expect(janInputs).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.items).toHaveLength(2)
  })
})
