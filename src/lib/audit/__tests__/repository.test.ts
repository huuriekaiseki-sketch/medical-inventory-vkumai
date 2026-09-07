import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listAccessDenials, listAuditLog } from '../repository'
import type { AuditQuery } from '@/types/audit'

// WHY: issue #757 の 4・24・5。ここで固定するのは 3 つ:
//        - 行の中身（old_data / new_data）を選んでいない（患者 ID が画面と JSON に出ない）
//        - 新しい順に並べ、件数の範囲を渡している
//        - 絞り込みが指定した分だけ where になる（未指定は付けない）

interface Recorder {
  selected: string
  order: Array<[string, unknown]>
  range: Array<[number, number]>
  eq: Array<[string, unknown]>
  gte: Array<[string, unknown]>
  lte: Array<[string, unknown]>
  table: string
}

function makeDb(rows: unknown[] = []) {
  const rec: Recorder = { selected: '', order: [], range: [], eq: [], gte: [], lte: [], table: '' }
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  Object.assign(builder, {
    select: (cols: string) => {
      rec.selected = cols
      return chain()
    },
    order: (col: string, opts: unknown) => {
      rec.order.push([col, opts])
      return chain()
    },
    range: (from: number, to: number) => {
      rec.range.push([from, to])
      return chain()
    },
    eq: (col: string, value: unknown) => {
      rec.eq.push([col, value])
      return chain()
    },
    gte: (col: string, value: unknown) => {
      rec.gte.push([col, value])
      return chain()
    },
    lte: (col: string, value: unknown) => {
      rec.lte.push([col, value])
      return chain()
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  })
  const db = {
    from: (table: string) => {
      rec.table = table
      return builder
    },
  }
  return { db: db as never, rec }
}

const baseQuery: AuditQuery = { kind: 'changes', limit: 50, offset: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('監査ログの取得（listAuditLog）', () => {
  it('行の中身（old_data / new_data）を選ばない', async () => {
    const { db, rec } = makeDb()
    await listAuditLog(db, baseQuery)
    expect(rec.table).toBe('audit_log')
    expect(rec.selected).not.toContain('old_data')
    expect(rec.selected).not.toContain('new_data')
    expect(rec.selected).toContain('changed_columns')
  })

  it('新しい順に並べ、件数の範囲を渡す', async () => {
    const { db, rec } = makeDb()
    await listAuditLog(db, { ...baseQuery, limit: 20, offset: 40 })
    expect(rec.order).toEqual([['occurred_at', { ascending: false }]])
    expect(rec.range).toEqual([[40, 59]])
  })

  it('指定した絞り込みだけが where になる', async () => {
    const { db, rec } = makeDb()
    await listAuditLog(db, { ...baseQuery, facilityId: 'f1', tableName: 'case_orders' })
    expect(rec.eq).toEqual([
      ['facility_id', 'f1'],
      ['table_name', 'case_orders'],
    ])
    expect(rec.gte).toEqual([])
    expect(rec.lte).toEqual([])
  })

  it('日付は JST の日境界に変換して渡す', async () => {
    const { db, rec } = makeDb()
    await listAuditLog(db, { ...baseQuery, dateFrom: '2026-09-01', dateTo: '2026-09-07' })
    expect(rec.gte[0][1]).toBe('2026-09-01T00:00:00+09:00')
    expect(String(rec.lte[0][1])).toContain('2026-09-07T23:59:59')
  })

  it('行を画面向けの形に写す', async () => {
    const { db } = makeDb([
      {
        id: 'x1',
        occurred_at: '2026-09-07T00:00:00Z',
        table_name: 'case_orders',
        action: 'UPDATE',
        actor_id: 'a1',
        actor_role: 'authenticated',
        facility_id: 'f1',
        row_id: 'r1',
        changed_columns: ['status'],
      },
    ])
    const rows = await listAuditLog(db, baseQuery)
    expect(rows).toEqual([
      {
        id: 'x1',
        occurredAt: '2026-09-07T00:00:00Z',
        tableName: 'case_orders',
        action: 'UPDATE',
        actorId: 'a1',
        actorRole: 'authenticated',
        facilityId: 'f1',
        rowId: 'r1',
        changedColumns: ['status'],
      },
    ])
  })

  it('エラーはそのまま投げる（route が 403 / 500 に振り分ける）', async () => {
    const { db } = makeDb()
    const failing = {
      from: () => ({
        select: () => ({
          order: () => ({
            range: () => ({
              then: (resolve: (v: unknown) => unknown) =>
                resolve({ data: null, error: new Error('permission denied') }),
            }),
          }),
        }),
      }),
    }
    void db
    await expect(listAuditLog(failing as never, baseQuery)).rejects.toThrow('permission denied')
  })
})

describe('拒否の記録の取得（listAccessDenials）', () => {
  it('拒否の表を新しい順に読み、guard で絞れる', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, { ...baseQuery, kind: 'denials', guard: 'facility' })
    expect(rec.table).toBe('access_denials')
    expect(rec.order).toEqual([['occurred_at', { ascending: false }]])
    expect(rec.eq).toEqual([['guard', 'facility']])
  })

  it('行を画面向けの形に写す', async () => {
    const { db } = makeDb([
      {
        id: 'd1',
        occurred_at: '2026-09-07T01:00:00Z',
        guard: 'facility',
        reason: 'forbidden',
        actor_id: null,
        facility_id: null,
        route: '/api/orders',
        method: 'GET',
      },
    ])
    const rows = await listAccessDenials(db, { ...baseQuery, kind: 'denials' })
    expect(rows[0]).toEqual({
      id: 'd1',
      occurredAt: '2026-09-07T01:00:00Z',
      guard: 'facility',
      reason: 'forbidden',
      actorId: null,
      facilityId: null,
      route: '/api/orders',
      method: 'GET',
    })
  })
})
