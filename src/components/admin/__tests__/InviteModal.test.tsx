import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InviteModal } from '../InviteModal'

describe('InviteModal', () => {
  it('open=false のとき何も表示されない', () => {
    render(<InviteModal open={false} onClose={vi.fn()} onInvite={vi.fn()} />)
    expect(screen.queryByText('ユーザーを招待')).not.toBeInTheDocument()
  })

  it('open=true のときモーダルが表示される', () => {
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={vi.fn()} />)
    expect(screen.getByText('ユーザーを招待')).toBeInTheDocument()
  })

  it('メールを入力して送信すると onInvite が呼ばれる', () => {
    const onInvite = vi.fn()
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={onInvite} />)
    fireEvent.change(screen.getByPlaceholderText('メールアドレス'), {
      target: { value: 'new@test.com' },
    })
    fireEvent.click(screen.getByText('招待する'))
    expect(onInvite).toHaveBeenCalledWith('new@test.com')
  })

  it('メール未入力のとき onInvite は呼ばれない', () => {
    const onInvite = vi.fn()
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={onInvite} />)
    fireEvent.click(screen.getByText('招待する'))
    expect(onInvite).not.toHaveBeenCalled()
  })
})
