import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderButtons } from '../OrderButtons'

describe('OrderButtons', () => {
  it('4つのリンクと1つのdisabledボタンが表示される', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('link', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '消耗品発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeInTheDocument()
  })

  it('症例発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('link', { name: '症例発注' })).toHaveAttribute('href', '/facilities/f-1/case-orders')
  })

  it('消耗品発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('link', { name: '消耗品発注' })).toHaveAttribute('href', '/facilities/f-1/consumable-orders')
  })

  it('短貸発注リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('link', { name: '短貸発注' })).toHaveAttribute('href', '/facilities/f-1/loan-orders')
  })

  it('短貸返却リンクは正しいhrefを持つ', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('link', { name: '短貸返却' })).toHaveAttribute('href', '/facilities/f-1/loan-returns')
  })

  it('長貸し処理ボタンはdisabledである', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeDisabled()
  })
})
