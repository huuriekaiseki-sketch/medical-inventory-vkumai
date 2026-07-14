import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderKindBadge } from '../OrderKindBadge'
import type { OrderKind } from '@/types/order'

const KINDS: { kind: OrderKind; label: string }[] = [
  { kind: 'case', label: '症例発注' },
  { kind: 'consumable', label: '消耗品発注' },
  { kind: 'loan', label: '短貸発注' },
  { kind: 'loan_return', label: '短貸返却' },
]

describe('OrderKindBadge', () => {
  it.each(KINDS)('$kind 種別のラベルが表示される', ({ kind, label }) => {
    render(<OrderKindBadge kind={kind} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it.each(KINDS)('$kind 種別に aria-label が設定される', ({ kind, label }) => {
    render(<OrderKindBadge kind={kind} />)
    expect(screen.getByLabelText(`種別: ${label}`)).toBeInTheDocument()
  })

  it('未知の種別が渡されてもエラーにならずフォールバック表示する', () => {
    // @ts-expect-error 型安全性のテストではなく、防御的フォールバックの確認
    render(<OrderKindBadge kind="unknown" />)
    expect(screen.getByText('unknown')).toBeInTheDocument()
  })
})
