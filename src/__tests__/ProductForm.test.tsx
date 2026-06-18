import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ProductForm } from '@/components/products/ProductForm'
import type { ProductInput } from '@/types/product'

describe('ProductForm', () => {
  const noop = vi.fn()

  it('空フォームが正しくレンダリングされる', () => {
    render(<ProductForm onSubmit={noop} />)

    expect(screen.getByLabelText('製品名')).toBeInTheDocument()
    expect(screen.getByLabelText('製品コード')).toBeInTheDocument()
    expect(screen.getByLabelText('カテゴリ')).toBeInTheDocument()
    expect(screen.getByLabelText('単位')).toBeInTheDocument()
    expect(screen.getByLabelText('単価')).toBeInTheDocument()

    // 必須フィールドは required 属性を持つ
    expect(screen.getByLabelText('製品名')).toBeRequired()
    expect(screen.getByLabelText('製品コード')).toBeRequired()
    expect(screen.getByLabelText('カテゴリ')).toBeRequired()
    expect(screen.getByLabelText('単位')).toBeRequired()

    // 単価は任意
    expect(screen.getByLabelText('単価')).not.toBeRequired()

    // デフォルトボタンラベルは「保存」
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
  })

  it('defaultValues が正しくプリセットされる', () => {
    const defaults: ProductInput = {
      name: 'テスト製品',
      code: 'TEST-001',
      category: '試薬',
      unit: '本',
      unitPrice: 1500,
    }

    render(<ProductForm onSubmit={noop} defaultValues={defaults} />)

    expect(screen.getByLabelText('製品名')).toHaveValue('テスト製品')
    expect(screen.getByLabelText('製品コード')).toHaveValue('TEST-001')
    expect(screen.getByLabelText('カテゴリ')).toHaveValue('試薬')
    expect(screen.getByLabelText('単位')).toHaveValue('本')
    expect(screen.getByLabelText('単価')).toHaveValue(1500)
  })

  it('全必須項目入力後に submit すると onSubmit が正しい値で呼ばれる', async () => {
    const handleSubmit = vi.fn()
    const user = userEvent.setup()

    render(<ProductForm onSubmit={handleSubmit} />)

    await user.type(screen.getByLabelText('製品名'), 'ガーゼ')
    await user.type(screen.getByLabelText('製品コード'), 'GZ-100')
    await user.selectOptions(screen.getByLabelText('カテゴリ'), '消耗品')
    await user.type(screen.getByLabelText('単位'), '枚')
    await user.type(screen.getByLabelText('単価'), '200')

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(handleSubmit).toHaveBeenCalledOnce()
    expect(handleSubmit).toHaveBeenCalledWith({
      name: 'ガーゼ',
      code: 'GZ-100',
      category: '消耗品',
      unit: '枚',
      unitPrice: 200,
    })
  })

  it('submitLabel が反映される', () => {
    render(<ProductForm onSubmit={noop} submitLabel="登録する" />)

    expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })
})
