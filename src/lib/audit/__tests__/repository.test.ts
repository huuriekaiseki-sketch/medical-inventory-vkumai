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
    await listAuditLog(db, {
      ...baseQuery, facilityId: 'f1', actorId: 'a1', tableName: 'case_orders',
    })
    expect(rec.eq).toEqual([
      ['facility_id', 'f1'],
      ['actor_id', 'a1'],
      ['table_name', 'case_orders'],
    ])
    expect(rec.gte).toEqual([])
    expect(rec.lte).toEqual([])
  })

  it('日付は occurred_at 列に、JST の日境界へ変換して渡す', async () => {
    const { db, rec } = makeDb()
    await listAuditLog(db, { ...baseQuery, dateFrom: '2026-09-01', dateTo: '2026-09-07' })
    // WHY(列名も見る): 値だけ見ていると、比較先の列を別の列（あるいは空文字）に
    //      すり替えても気づけない。期間で絞ったつもりが絞れていない状態になる
    expect(rec.gte).toEqual([['occurred_at', '2026-09-01T00:00:00+09:00']])
    expect(rec.lte[0][0]).toBe('occurred_at')
    expect(String(rec.lte[0][1])).toContain('2026-09-07T23:59:59')
  })

  it('data が null でも空リストを返す（例外にしない）', async () => {
    const { db } = makeDb()
    const nullData = {
      from: () => ({
        select: () => ({
          order: () => ({
            range: () => ({
              then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }
    void db
    await expect(listAuditLog(nullData as never, baseQuery)).resolves.toEqual([])
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

// WHY(2026-09-07 のミューテーション計測): この describe は 2 件しか無く、効き目は 65% だった。
//      listAuditLog 側と同じ検査が片方だけ書かれていない状態で、listAccessDenials は
//      **絞り込みを全部消しても・件数の範囲を狂わせても・エラーを握り潰しても**全テストが緑だった
//      （`if (query.facilityId) q = q.eq(...)` → `if (false)`、`.range(a, a + n - 1)` → `+ n + 1`、
//      `if (error) throw error` → `if (false)`）。監査画面の絞り込みは「誰がどこで弾かれたか」を
//      調べる唯一の手段なので、静かに効かなくなると事故の調査そのものが空振りする。
//      listAuditLog と同じ観点をこちらにも揃える。
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

  it('件数の範囲を offset から limit 件だけ渡す', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, { ...baseQuery, kind: 'denials', limit: 20, offset: 40 })
    // range は両端を含むので、40 件目から 20 件なら 40..59。ここがずれると
    // 画面の 1 ページに隣のページの行が混ざる／取りこぼす
    expect(rec.range).toEqual([[40, 59]])
  })

  it('画面に出す列だけを選ぶ（拒否の記録は行の中身を持たない）', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, { ...baseQuery, kind: 'denials' })
    for (const col of ['guard', 'reason', 'actor_id', 'facility_id', 'route', 'method']) {
      expect(rec.selected).toContain(col)
    }
    expect(rec.selected).not.toBe('')
  })

  it('指定した絞り込みだけが where になる', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, {
      ...baseQuery, kind: 'denials', facilityId: 'f1', actorId: 'a1', guard: 'admin',
    })
    expect(rec.eq).toEqual([
      ['facility_id', 'f1'],
      ['actor_id', 'a1'],
      ['guard', 'admin'],
    ])
    expect(rec.gte).toEqual([])
    expect(rec.lte).toEqual([])
  })

  it('絞り込みを指定しなければ where を付けない（全件が出る）', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, { ...baseQuery, kind: 'denials' })
    expect(rec.eq).toEqual([])
    expect(rec.gte).toEqual([])
    expect(rec.lte).toEqual([])
  })

  it('日付は occurred_at 列に、JST の日境界へ変換して渡す', async () => {
    const { db, rec } = makeDb()
    await listAccessDenials(db, {
      ...baseQuery, kind: 'denials', dateFrom: '2026-09-01', dateTo: '2026-09-07',
    })
    expect(rec.gte).toEqual([['occurred_at', '2026-09-01T00:00:00+09:00']])
    expect(rec.lte[0][0]).toBe('occurred_at')
    expect(String(rec.lte[0][1])).toContain('2026-09-07T23:59:59')
  })

  it('data が null でも空リストを返す（例外にしない）', async () => {
    const nullData = {
      from: () => ({
        select: () => ({
          order: () => ({
            range: () => ({
              then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }
    await expect(listAccessDenials(nullData as never, { ...baseQuery, kind: 'denials' }))
      .resolves.toEqual([])
  })

  it('エラーはそのまま投げる（握り潰して空リストにしない）', async () => {
    // WHY: ここを握り潰すと、RLS で読めていないのか本当に 0 件なのかが画面から区別できない。
    //      「拒否が 0 件」は安全のしるしに見えるので、静かな 0 件は最も危ない失敗の形。
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
    await expect(listAccessDenials(failing as never, { ...baseQuery, kind: 'denials' }))
      .rejects.toThrow('permission denied')
  })
})
