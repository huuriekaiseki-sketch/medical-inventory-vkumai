import { describe, expect, it } from 'vitest'
import { CLIENT_REQUEST_ID_INVALID_MESSAGE, isClientRequestId, validateClientRequestId } from '@/lib/client-request-id'

// WHY: route が受ける鍵の形だけを固定する（P-053）。業務判定は DB（UNIQUE と RPC の再送処理）が持つ
describe('client-request-id（二重送信対策の鍵の形）', () => {
  it('UUID v4 の文字列を受け付ける（大文字も可）', () => {
    expect(isClientRequestId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
    expect(isClientRequestId('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true)
    expect(isClientRequestId(crypto.randomUUID())).toBe(true)
  })

  it.each([
    ['空文字', ''],
    ['短い', 'abc'],
    ['区切り無し', '3f2504e04f8941d39a0c0305e82c3301'],
    ['16 進以外', 'zz2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['数値', 1234],
    ['オブジェクト', { id: 'x' }],
  ])('UUID でない値は拒否する: %s', (_label, value) => {
    expect(isClientRequestId(value)).toBe(false)
  })

  it('validateClientRequestId: 未指定は ok（値なし）、UUID は ok（値あり）、それ以外は固定文言', () => {
    expect(validateClientRequestId(undefined)).toEqual({ ok: true })
    expect(validateClientRequestId(null)).toEqual({ ok: true })
    const id = crypto.randomUUID()
    expect(validateClientRequestId(id)).toEqual({ ok: true, value: id })
    expect(validateClientRequestId('not-a-uuid')).toEqual({ ok: false, message: CLIENT_REQUEST_ID_INVALID_MESSAGE })
  })
})
