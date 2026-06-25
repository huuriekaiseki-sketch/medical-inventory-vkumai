import { describe, it, expect } from 'vitest'
import { apiError } from '@/lib/api-error'

describe('apiError', () => {
  it('{ error: string } 形式で返す', async () => {
    const res = apiError('失敗しました')
    const body = await res.json()
    expect(body).toEqual({ error: '失敗しました' })
  })

  it('デフォルトステータスは 500', () => {
    const res = apiError('失敗しました')
    expect(res.status).toBe(500)
  })

  it('ステータスを指定できる', () => {
    const res = apiError('見つかりません', 404)
    expect(res.status).toBe(404)
  })
})
