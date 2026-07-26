import { describe, it, expect, vi, afterEach } from 'vitest'
import { toClientErrorMessage } from './api-error'
import { ClientVisibleError } from './client-visible-error'

describe('toClientErrorMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ClientVisibleErrorのmessageはそのまま返す(repository層が安全と保証した翻訳済みメッセージ)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new ClientVisibleError('カテゴリ名が既に使用されています')
    expect(toClientErrorMessage(error, 'fallback')).toBe('カテゴリ名が既に使用されています')
  })

  it('通常のErrorインスタンスを渡してもfallbackMessageのみ返す(生のDBエラー漏洩防止)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('relation "products" does not exist')
    expect(toClientErrorMessage(error, '製品の取得に失敗しました')).toBe('製品の取得に失敗しました')
  })

  it('文字列を渡してもfallbackMessageのみ返す（元のmessageを含まない）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = toClientErrorMessage('duplicate key value violates unique constraint "products_jan_key"', 'fallback')
    expect(result).toBe('fallback')
    expect(result).not.toContain('products_jan_key')
  })

  it('ClientVisibleError以外はconsole.errorにerror内容を記録する', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('detail')
    toClientErrorMessage(error, 'fallback')
    expect(spy).toHaveBeenCalledWith(error)
  })

  it('ClientVisibleErrorの場合はconsole.errorを呼ばない(想定内の業務エラーのためログ不要)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new ClientVisibleError('使用中のため削除できません')
    toClientErrorMessage(error, 'fallback')
    expect(spy).not.toHaveBeenCalled()
  })
})
