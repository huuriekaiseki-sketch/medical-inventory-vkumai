import { describe, it, expect, vi } from 'vitest'
import { sanitizeDbError } from './api-error'

describe('sanitizeDbError', () => {
  it('Errorインスタンスを渡してもfallbackMessageのみ返す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('relation "products" does not exist')
    expect(sanitizeDbError(error, '製品の取得に失敗しました')).toBe('製品の取得に失敗しました')
  })

  it('文字列を渡してもfallbackMessageのみ返す（元のmessageを含まない）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = sanitizeDbError('duplicate key value violates unique constraint "products_jan_key"', 'fallback')
    expect(result).toBe('fallback')
    expect(result).not.toContain('products_jan_key')
  })

  it('console.errorにerror内容を記録する', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('detail')
    sanitizeDbError(error, 'fallback')
    expect(spy).toHaveBeenCalledWith(error)
  })
})
