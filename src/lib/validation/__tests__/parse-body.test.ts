import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { parseBody } from '../parse-body'
import { consumableInputSchema } from '../schemas'
import { TEXT_LIMITS } from '../text-limits'

// WHY: issue #757 の 20。静的な検査（parseBody を呼んでいるか）に加えて、
//      **実際に長すぎる本文を投げて 400 が返る**ことを挙動で確かめる。
//      「呼んではいるが効いていない」を捕まえられるのは挙動の側だけ。

function post(body: unknown, raw?: string) {
  return new NextRequest('http://localhost/api/x', {
    method: 'POST',
    body: raw ?? JSON.stringify(body),
  })
}

describe('本文を読む唯一の入口（parseBody）', () => {
  const schema = z.object({ name: z.string().min(1) })

  it('正しい本文はそのまま返す', async () => {
    const r = await parseBody(post({ name: '手袋' }), schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.name).toBe('手袋')
  })

  it('JSON でない本文は 400（中身は鸚鵡返しにしない）', async () => {
    const r = await parseBody(post(null, 'これは JSON ではない'), schema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response.status).toBe(400)
      const body = await r.response.json()
      expect(body.error).toBe('リクエストが不正です')
      expect(body.error).not.toContain('これは JSON ではない')
    }
  })

  it('検証に失敗したら 400 と最初の 1 件のメッセージを返す', async () => {
    const r = await parseBody(post({ name: '' }), schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(400)
  })

  it('長すぎる自由入力は 400 で、上限が文言に入る', async () => {
    const r = await parseBody(
      post({
        facilityId: 'f1',
        name: 'あ'.repeat(TEXT_LIMITS.productName + 1),
        purpose: '術中',
      }),
      consumableInputSchema
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response.status).toBe(400)
      const body = await r.response.json()
      expect(body.error).toContain(String(TEXT_LIMITS.productName))
    }
  })

  it('1 MB の本文も 400 で止まる（2026-09-07 に実際に保存できていた入力）', async () => {
    const r = await parseBody(
      post({ facilityId: 'f1', name: 'あ'.repeat(1_000_000), purpose: '術中' }),
      consumableInputSchema
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(400)
  })
})
