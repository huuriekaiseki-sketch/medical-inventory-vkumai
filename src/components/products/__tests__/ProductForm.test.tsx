import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductForm } from '../ProductForm'

describe('ProductForm', () => {
  it('name・maker入力欄が表示される', () => {
    render(<ProductForm onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('製品名')).toBeInTheDocument()
    expect(screen.getByLabelText('メーカー名')).toBeInTheDocument()
  })

  it('name入力欄はrequiredが付いている', () => {
    render(<ProductForm onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('製品名')).toBeRequired()
  })

  it('maker入力欄はrequiredが付いていない', () => {
    render(<ProductForm onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('メーカー名')).not.toBeRequired()
  })

  it('name・makerを入力して送信するとonSubmitにname/makerが渡される', async () => {
    const onSubmit = vi.fn()
    render(<ProductForm onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('JAN コード'), '4900000000001')
    await userEvent.type(screen.getByLabelText('REF コード'), 'REF-1')
    await userEvent.type(screen.getByLabelText('製品名'), 'カテーテルAB型')
    await userEvent.type(screen.getByLabelText('メーカー名'), 'テルモ')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledWith({
      jan: '4900000000001',
      ref: 'REF-1',
      name: 'カテーテルAB型',
      maker: 'テルモ',
    })
  })

  it('makerを未入力で送信するとmakerはnullで渡される', async () => {
    const onSubmit = vi.fn()
    render(<ProductForm onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText('JAN コード'), '4900000000001')
    await userEvent.type(screen.getByLabelText('REF コード'), 'REF-1')
    await userEvent.type(screen.getByLabelText('製品名'), 'カテーテルAB型')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledWith({
      jan: '4900000000001',
      ref: 'REF-1',
      name: 'カテーテルAB型',
      maker: null,
    })
  })

  it('defaultValuesのname・makerが初期値として反映される', () => {
    render(
      <ProductForm
        defaultValues={{ jan: '123', ref: 'R1', name: 'カテーテルAB型', maker: 'テルモ' }}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByLabelText('製品名')).toHaveValue('カテーテルAB型')
    expect(screen.getByLabelText('メーカー名')).toHaveValue('テルモ')
  })
})
