import { describe, it, expect } from 'vitest'
import { encodeProxyDenial, parseProxyDenial } from '../denial-headers'

// WHY(#757-24): parseProxyDenial は proxy が付けた httpOnly cookie の中身を復元する唯一の入口。
//      URL引数やdocument.cookieからの偽装を弾く検証ロジックそのものをテストする
describe('encodeProxyDenial / parseProxyDenial', () => {
  it('正常な2語（unauthenticated）を符号化・復元できる', () => {
    const payload = { reason: 'unauthenticated' as const, route: '/admin', method: 'GET' }
    expect(parseProxyDenial(encodeProxyDenial(payload))).toEqual(payload)
  })

  it('正常な2語（not_admin）を符号化・復元できる', () => {
    const payload = { reason: 'not_admin' as const, route: '/api/admin/users', method: 'POST' }
    expect(parseProxyDenial(encodeProxyDenial(payload))).toEqual(payload)
  })

  it('undefined は null を返す', () => {
    expect(parseProxyDenial(undefined)).toBeNull()
  })

  it('JSON でない文字列は null を返す', () => {
    expect(parseProxyDenial('not-json')).toBeNull()
  })

  it('reason が想定の2語以外なら null を返す', () => {
    const raw = JSON.stringify({ reason: 'something_else', route: '/admin', method: 'GET' })
    expect(parseProxyDenial(raw)).toBeNull()
  })

  it('route が200文字を超えるなら null を返す（切らずに拒否）', () => {
    const raw = JSON.stringify({
      reason: 'unauthenticated',
      route: '/' + 'a'.repeat(200),
      method: 'GET',
    })
    expect(parseProxyDenial(raw)).toBeNull()
  })

  it('route に制御文字が含まれるなら null を返す', () => {
    const raw = JSON.stringify({ reason: 'unauthenticated', route: '/admin\x00', method: 'GET' })
    expect(parseProxyDenial(raw)).toBeNull()
  })

  it('method に制御文字が含まれるなら null を返す', () => {
    const raw = JSON.stringify({ reason: 'unauthenticated', route: '/admin', method: 'GET\x1f' })
    expect(parseProxyDenial(raw)).toBeNull()
  })

  it('余分なプロパティを含む場合は null を返す（strictスキーマ）', () => {
    const raw = JSON.stringify({
      reason: 'unauthenticated',
      route: '/admin',
      method: 'GET',
      actorId: 'forged-user-id',
    })
    expect(parseProxyDenial(raw)).toBeNull()
  })
})
