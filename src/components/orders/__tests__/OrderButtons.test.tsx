import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderButtons } from '../OrderButtons'

describe('OrderButtons', () => {
  it('staffの場合、4つのリンクと1つのdisabledボタンが表示される', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('link', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '消耗品発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeInTheDocument()
  })

  it('adminの場合も同様にボタンが表示される', () => {
    render(<OrderButtons facilityId="f-1" role="admin" />)
    expect(screen.getByRole('link', { name: '症例発注' })).toBeInTheDocument()
  })

  it('症例発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('link', { name: '症例発注' })).toHaveAttribute('href', '/facilities/f-1/case-orders')
  })

  it('消耗品発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('link', { name: '消耗品発注' })).toHaveAttribute('href', '/facilities/f-1/consumable-orders')
  })

  it('短貸発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('link', { name: '短貸発注' })).toHaveAttribute('href', '/facilities/f-1/loan-orders')
  })

  it('短貸返却リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('link', { name: '短貸返却' })).toHaveAttribute('href', '/facilities/f-1/loan-returns')
  })

  it('長貸し処理ボタンはdisabledである', () => {
    render(<OrderButtons facilityId="f-1" role="staff" />)
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeDisabled()
  })

  it('viewerの場合、発注リンクは表示されず案内メッセージが表示される(issue #608)', () => {
    render(<OrderButtons facilityId="f-1" role="viewer" />)
    expect(screen.queryByRole('link', { name: '症例発注' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '消耗品発注' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '短貸発注' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '短貸返却' })).not.toBeInTheDocument()
    expect(screen.getByText('閲覧のみの権限のため、発注・返却はできません。')).toBeInTheDocument()
  })

  it('未所属(null)の場合も発注リンクを表示しない', () => {
    render(<OrderButtons facilityId="f-1" role={null} />)
    expect(screen.queryByRole('link', { name: '症例発注' })).not.toBeInTheDocument()
  })

  it('role取得中(undefined)はプレースホルダのみでリンクも案内メッセージも表示しない', () => {
    render(<OrderButtons facilityId="f-1" role={undefined} />)
    expect(screen.queryByRole('link', { name: '症例発注' })).not.toBeInTheDocument()
    expect(screen.queryByText('閲覧のみの権限のため、発注・返却はできません。')).not.toBeInTheDocument()
  })
})
