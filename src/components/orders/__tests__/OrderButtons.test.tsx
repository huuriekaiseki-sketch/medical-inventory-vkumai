import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrderButtons } from '../OrderButtons'

vi.mock('../CaseOrderModal', () => ({
  CaseOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>症例発注モーダル</div> : null,
}))
vi.mock('../ConsumableOrderModal', () => ({
  ConsumableOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>消耗品発注モーダル</div> : null,
}))
vi.mock('../LoanOrderModal', () => ({
  LoanOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>短貸発注モーダル</div> : null,
}))
vi.mock('../LoanReturnModal', () => ({
  LoanReturnModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>短貸返却モーダル</div> : null,
}))

describe('OrderButtons', () => {
  it('5つのボタンが表示される', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('button', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '消耗品発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeInTheDocument()
  })

  it('症例発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '症例発注' }))
    expect(screen.getByText('症例発注モーダル')).toBeInTheDocument()
  })

  it('消耗品発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '消耗品発注' }))
    expect(screen.getByText('消耗品発注モーダル')).toBeInTheDocument()
  })

  it('短貸発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '短貸発注' }))
    expect(screen.getByText('短貸発注モーダル')).toBeInTheDocument()
  })

  it('短貸返却ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '短貸返却' }))
    expect(screen.getByText('短貸返却モーダル')).toBeInTheDocument()
  })

  it('長貸し処理ボタンはdisabledである', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeDisabled()
  })
})
