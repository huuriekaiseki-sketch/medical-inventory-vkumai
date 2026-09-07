// supabase/__tests__/integration/audit-completeness.integration.test.ts
// WHY: issue #757 の 24（監査証跡の完全性）。既存の audit-log-rls-idor は
//      16 の監査対象のうち 4 つ（loan_orders / loan_order_items / hospital_prices /
//      user_facilities）しか触っていない。残り 12 は「トリガーが付いている」という
//      migration の記述を信じているだけで、**本当に 1 行残るかを一度も測っていない**。
//
//      ここで測るのは 1 つの性質だけ:
//        「監査対象のテーブルへの INSERT / UPDATE / DELETE は、それぞれ監査行を
//          ちょうど 1 行だけ生む」
//      0 行なら取りこぼし、2 行以上ならトリガーの二重付与（どちらも実害がある）。
//
//      対象の一覧は migration の SQL から機械的に取り出す（書き写しを作らない）。
//      一覧にあってここに手当てが無いテーブルがあれば、まずそれで落ちる
//      ＝ 新しく監査対象にしたテーブルは、必ずここに実測が要る。
//      静的側（新しいテーブルが黙って対象外にならないか）は
//      supabase/migrations/__tests__/audit_trigger_coverage.test.ts が見る。

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  type SeededUser,
} from './helpers/seed-rls-idor'
import { auditedTablesFromMigrations } from '../helpers/table-facts'

type AuditRow = {
  id: string
  table_name: string
  row_id: string | null
  facility_id: string | null
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
}

const service = createServiceRoleClient()
const tag = randomUUID().slice(0, 8)

/** 1 つのテーブルについて「作る・変える・消す」をどう行うか */
interface TableCase {
  /** 監査行の facility_id に何が入るはずか。'fixture' = 用意した施設 ID、null = 列を持たない */
  facilityId: 'fixture' | null
  /** row_id が入らないテーブル（複合主キーで id 列を持たない）は false */
  hasRowId?: boolean
  insert: () => Promise<Record<string, unknown>>
  /** 値が実際に変わる UPDATE を 1 つ返す */
  patch: Record<string, unknown>
}

describe('監査ログの取りこぼし: 全対象テーブルで書き込み 1 回につき監査 1 行 [P-060]', () => {
  let facilityId: string
  let userId: string
  let staff: SeededUser
  let productA: string
  let productB: string
  let categoryId: string
  let distributorProductId: string
  let consumableId: string
  let caseOrderId: string
  let consumableOrderId: string
  let loanOrderId: string
  let loanReturnId: string
  let cases: Record<string, TableCase>

  const insertReturningId = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await service.from(table).insert(row).select('id').single()
    if (error) throw new Error(`${table} の下ごしらえに失敗: ${error.message}`)
    return (data as { id: string }).id
  }

  beforeAll(async () => {
    // 実データを混ぜないためダミー名のみ（.claude/rules/e2e-test-hygiene.md）
    facilityId = (await createFacility(service, `監査完全性テスト施設-${tag}`)).id

    const { data: user, error: userError } = await service.auth.admin.createUser({
      email: `audit-completeness-${tag}@example.test`,
      password: 'test-password-1234',
      email_confirm: true,
    })
    if (userError || !user.user) throw new Error(`ユーザー作成に失敗: ${userError?.message}`)
    userId = user.user.id

    categoryId = await insertReturningId('categories', { name: `監査テスト分類-${tag}` })
    productA = await insertReturningId('products', { jan: `A${tag}`, ref: `RA${tag}` })
    productB = await insertReturningId('products', { jan: `B${tag}`, ref: `RB${tag}` })
    distributorProductId = await insertReturningId('distributor_products', {
      product_id: productA,
      maker: 'ダミーメーカー',
      supplier: 'ダミー販売店',
      name: 'ダミー製品',
      quantity: 1,
      category_id: categoryId,
    })
    consumableId = await insertReturningId('consumables', {
      facility_id: facilityId,
      name: 'ダミー消耗品',
      purpose: 'ダミー用途',
    })
    caseOrderId = await insertReturningId('case_orders', {
      facility_id: facilityId,
      case_datetime: new Date().toISOString(),
      procedure_name: 'ダミー術式',
      patient_id: 'DUMMY-1',
      patient_initials: 'DD',
      gender: 'other',
      doctor_name: 'ダミー医師',
    })
    consumableOrderId = await insertReturningId('consumable_orders', { facility_id: facilityId })
    loanOrderId = await insertReturningId('loan_orders', {
      facility_id: facilityId,
      procedure_name: 'ダミー術式',
      maker: 'ダミーメーカー',
    })
    loanReturnId = await insertReturningId('loan_returns', {
      facility_id: facilityId,
      return_datetime: new Date().toISOString(),
    })

    // 監査行を「施設の人が読めるか」を測るための、この施設に所属する利用者
    staff = await createSeededUser(service, `audit-completeness-staff-${tag}`, facilityId, 'staff')

    // 小さい方を product_id_1 に入れる制約（ordered_pair）に合わせる
    const [p1, p2] = [productA, productB].sort()

    cases = {
      facilities: {
        facilityId: null, // facilities 自身は facility_id 列を持たない
        insert: async () => ({ name: `監査テスト施設-${tag}-${randomUUID().slice(0, 8)}` }),
        patch: { name: `監査テスト施設-改名-${tag}-${randomUUID().slice(0, 8)}` },
      },
      categories: {
        facilityId: null,
        insert: async () => ({ name: `監査テスト分類-${tag}-${randomUUID().slice(0, 8)}` }),
        patch: { description: '変更後の説明' },
      },
      products: {
        facilityId: null,
        insert: async () => {
          const u = randomUUID().slice(0, 8)
          return { jan: `J${u}`, ref: `R${u}` }
        },
        patch: { name: '変更後の製品名' },
      },
      distributor_products: {
        facilityId: null,
        insert: async () => ({
          product_id: productB,
          maker: 'ダミーメーカー',
          supplier: 'ダミー販売店',
          name: 'ダミー製品2',
          quantity: 1,
          category_id: categoryId,
        }),
        patch: { supplier: '変更後の販売店' },
      },
      hospital_prices: {
        facilityId: 'fixture',
        insert: async () => ({
          distributor_product_id: distributorProductId,
          facility_id: facilityId,
          purchase_price: 100,
          delivery_price: 200,
        }),
        patch: { purchase_price: 150 },
      },
      consumables: {
        facilityId: 'fixture',
        insert: async () => ({ facility_id: facilityId, name: 'ダミー消耗品2', purpose: 'ダミー用途' }),
        patch: { purpose: '変更後の用途' },
      },
      product_compatibilities: {
        facilityId: null,
        insert: async () => ({ category_id: categoryId, product_id_1: p1, product_id_2: p2 }),
        patch: { note: '変更後の備考' },
      },
      user_facilities: {
        facilityId: 'fixture',
        hasRowId: false, // 複合主キーで id 列が無い
        insert: async () => ({ user_id: userId, facility_id: facilityId, role: 'staff' }),
        patch: { role: 'viewer' },
      },
      case_orders: {
        facilityId: 'fixture',
        insert: async () => ({
          facility_id: facilityId,
          case_datetime: new Date().toISOString(),
          procedure_name: 'ダミー術式2',
          patient_id: 'DUMMY-2',
          patient_initials: 'EE',
          gender: 'other',
          doctor_name: 'ダミー医師',
        }),
        patch: { status: 'submitted' },
      },
      case_order_items: {
        // 明細は facility_id 列を持たないが、20260907008000 でトリガーが親からたどる
        facilityId: 'fixture',
        insert: async () => ({ case_order_id: caseOrderId, jan: `A${tag}`, quantity: 1 }),
        patch: { quantity: 3 },
      },
      consumable_orders: {
        facilityId: 'fixture',
        insert: async () => ({ facility_id: facilityId }),
        patch: { status: 'submitted' },
      },
      consumable_order_items: {
        facilityId: 'fixture', // 親からたどる（20260907008000）
        insert: async () => ({
          consumable_order_id: consumableOrderId,
          consumable_id: consumableId,
          quantity: 1,
        }),
        patch: { quantity: 4 },
      },
      loan_orders: {
        facilityId: 'fixture',
        insert: async () => ({
          facility_id: facilityId,
          procedure_name: 'ダミー術式3',
          maker: 'ダミーメーカー',
        }),
        patch: { status: 'submitted' },
      },
      loan_order_items: {
        facilityId: 'fixture', // 親からたどる（20260907008000）
        insert: async () => ({ loan_order_id: loanOrderId, name: 'ダミー明細', quantity: 1 }),
        patch: { quantity: 5 },
      },
      loan_returns: {
        facilityId: 'fixture',
        insert: async () => ({ facility_id: facilityId, return_datetime: new Date().toISOString() }),
        patch: { status: 'returned' },
      },
      loan_return_items: {
        facilityId: 'fixture', // 親からたどる（20260907008000）
        insert: async () => ({ loan_return_id: loanReturnId, jan: `A${tag}`, quantity: 1 }),
        patch: { quantity: 6 },
      },
    }
  }, 120_000)

  afterAll(async () => {
    if (staff) await service.auth.admin.deleteUser(staff.id)
    if (userId) await service.auth.admin.deleteUser(userId)
    if (facilityId) await service.from('facilities').delete().eq('id', facilityId)
    if (productA) await service.from('products').delete().in('id', [productA, productB])
    if (categoryId) await service.from('categories').delete().eq('id', categoryId)
  })

  /** 対象テーブルの監査行 ID の集合（差分を取るために使う） */
  const auditIds = async (table: string): Promise<Set<string>> => {
    const { data, error } = await service.from('audit_log').select('id').eq('table_name', table)
    if (error) throw new Error(`audit_log の取得に失敗: ${error.message}`)
    return new Set((data ?? []).map((r) => (r as { id: string }).id))
  }

  /** 直前の操作で増えた監査行だけを返す */
  const newRows = async (table: string, before: Set<string>): Promise<AuditRow[]> => {
    const { data, error } = await service
      .from('audit_log')
      .select('id, table_name, row_id, facility_id, action, old_data, new_data')
      .eq('table_name', table)
      .order('occurred_at')
    if (error) throw new Error(`audit_log の取得に失敗: ${error.message}`)
    return ((data ?? []) as AuditRow[]).filter((r) => !before.has(r.id))
  }

  it('監査対象の一覧に、ここで手当てしていないテーブルが無い（新しい対象は必ず実測される）', () => {
    const audited = auditedTablesFromMigrations()
    const missing = [...audited].filter((t) => !(t in cases))
    expect(missing, `${missing.join(', ')} の実測が無い（cases に足すこと）`).toEqual([])
    // 逆向き: ここにあるのに監査対象から外れたテーブル（陳腐化）
    const stale = Object.keys(cases).filter((t) => !audited.has(t))
    expect(stale, `${stale.join(', ')} は監査対象ではない（cases から消すこと）`).toEqual([])
  })

  it('INSERT / UPDATE / DELETE がそれぞれ監査行をちょうど 1 行だけ生む', async () => {
    // 1 件ずつ順に測る。取りこぼし（0 行）も二重付与（2 行以上）も、
    // どのテーブルのどの操作かが分かる形で集めてから 1 度に突き合わせる
    const problems: string[] = []

    for (const [table, c] of Object.entries(cases)) {
      const expectedFacility = c.facilityId === 'fixture' ? facilityId : null

      // --- INSERT ---
      let before = await auditIds(table)
      const row = await c.insert()
      const { data: inserted, error: insertError } = await service
        .from(table)
        .insert(row)
        .select('*')
        .single()
      if (insertError) {
        problems.push(`${table}: INSERT 自体に失敗（${insertError.message}）`)
        continue
      }
      const inserted_ = inserted as Record<string, unknown>

      // WHY(自分の行だけを数える): vitest は統合テストのファイルを並列で走らせるので、
      //      同じ表への他ファイルの書き込みが「増えた監査行」に混ざる。
      //      実際に case_order_items / consumable_order_items で 2 行になり誤検知した。
      //      増分から**今書いた行のものだけ**を取り出して数える。
      const isOurs = (r: AuditRow): boolean => {
        if (c.hasRowId !== false) return r.row_id === (inserted_.id as string)
        const body = (r.new_data ?? r.old_data) ?? {}
        return body.user_id === inserted_.user_id && body.facility_id === inserted_.facility_id
      }
      const ourNewRows = async (from: Set<string>) => (await newRows(table, from)).filter(isOurs)

      let rows = await ourNewRows(before)
      if (rows.length !== 1 || rows[0].action !== 'INSERT') {
        problems.push(`${table}: INSERT で ${rows.length} 行（期待 1 行 / INSERT）`)
      } else {
        if (rows[0].facility_id !== expectedFacility) {
          problems.push(`${table}: INSERT の facility_id が ${rows[0].facility_id}（期待 ${expectedFacility}）`)
        }
        const expectedRowId = c.hasRowId === false ? null : (inserted_.id as string)
        if (rows[0].row_id !== expectedRowId) {
          problems.push(`${table}: INSERT の row_id が ${rows[0].row_id}（期待 ${expectedRowId}）`)
        }
      }

      // 消すための絞り込み条件（id が無いテーブルは複合キーで指定する）
      const key: Record<string, unknown> =
        c.hasRowId === false
          ? { user_id: inserted_.user_id, facility_id: inserted_.facility_id }
          : { id: inserted_.id }
      const narrow = <T extends { eq: (c: string, v: unknown) => T }>(q: T): T =>
        Object.entries(key).reduce((acc, [k, v]) => acc.eq(k, v), q)

      // --- UPDATE ---
      before = await auditIds(table)
      const { error: updateError } = await narrow(service.from(table).update(c.patch) as never)
      if (updateError) {
        problems.push(`${table}: UPDATE 自体に失敗（${(updateError as { message: string }).message}）`)
      } else {
        rows = await ourNewRows(before)
        if (rows.length !== 1 || rows[0].action !== 'UPDATE') {
          problems.push(`${table}: UPDATE で ${rows.length} 行（期待 1 行 / UPDATE）`)
        }
      }

      // --- DELETE ---
      before = await auditIds(table)
      const { error: deleteError } = await narrow(service.from(table).delete() as never)
      if (deleteError) {
        problems.push(`${table}: DELETE 自体に失敗（${(deleteError as { message: string }).message}）`)
      } else {
        rows = await ourNewRows(before)
        if (rows.length !== 1 || rows[0].action !== 'DELETE') {
          problems.push(`${table}: DELETE で ${rows.length} 行（期待 1 行 / DELETE）`)
        } else if (rows[0].old_data === null) {
          problems.push(`${table}: DELETE の old_data が空（何が消えたか残っていない）`)
        }
      }
    }

    expect(problems).toEqual([])
  }, 180_000)

  // WHY: 監査ログは「残っている」だけでは足りず、「その施設の人が読める」で初めて使える。
  //      audit_log の SELECT ポリシーは is_admin() OR (facility_id IS NOT NULL AND
  //      is_facility_member(facility_id)) なので、facility_id が入らない行は
  //      全体管理者にしか見えない。明細（*_items）は facility_id 列を持たないため、
  //      ここに構造的な差がある。推測で書かず、実際に読んで測る。
  it('施設の人はヘッダも明細も監査行を読める（明細は親から facility_id をたどる）', async () => {
    const order = await service
      .from('loan_orders')
      .insert({ facility_id: facilityId, procedure_name: 'ダミー術式4', maker: 'ダミーメーカー' })
      .select('id')
      .single()
    const orderId = (order.data as { id: string }).id
    const item = await service
      .from('loan_order_items')
      .insert({ loan_order_id: orderId, name: 'ダミー明細2', quantity: 1 })
      .select('id')
      .single()
    const itemId = (item.data as { id: string }).id

    const readable = async (client: SupabaseClient, table: string, rowId: string) => {
      const { data } = await client.from('audit_log').select('id').eq('table_name', table).eq('row_id', rowId)
      return (data ?? []).length
    }

    // ヘッダは自分の facility_id が入る
    expect(await readable(staff.client, 'loan_orders', orderId)).toBe(1)
    // 明細は列を持たないが、トリガーが親（loan_orders）からたどって入れる
    expect(await readable(service, 'loan_order_items', itemId)).toBe(1)
    expect(await readable(staff.client, 'loan_order_items', itemId)).toBe(1)

    await service.from('loan_orders').delete().eq('id', orderId)
  }, 60_000)

  // WHY: 親ごと消したときだけは親からたどれない（PostgreSQL は親の DELETE のあとに
  //      カスケードで子を消すので、子の AFTER DELETE が走る時点で親の行が無い）。
  //      これは 20260907008000 のコメントに「あえて残す限界」と書いた挙動であり、
  //      書いただけで確かめないと本当かどうか分からないのでここで測る。
  //      施設の人が「その発注が消えた」ことは親の DELETE 監査行から追える。
  it('親ごと削除したときは明細の監査行の facility_id が null になる（親の行には入る）', async () => {
    const order = await service
      .from('loan_orders')
      .insert({ facility_id: facilityId, procedure_name: 'ダミー術式5', maker: 'ダミーメーカー' })
      .select('id')
      .single()
    const orderId = (order.data as { id: string }).id
    const item = await service
      .from('loan_order_items')
      .insert({ loan_order_id: orderId, name: 'ダミー明細3', quantity: 1 })
      .select('id')
      .single()
    const itemId = (item.data as { id: string }).id

    await service.from('loan_orders').delete().eq('id', orderId)

    const facilityOf = async (table: string, rowId: string) => {
      const { data } = await service
        .from('audit_log')
        .select('facility_id')
        .eq('table_name', table)
        .eq('row_id', rowId)
        .eq('action', 'DELETE')
      const rows = (data ?? []) as Array<{ facility_id: string | null }>
      expect(rows).toHaveLength(1)
      return rows[0].facility_id
    }

    expect(await facilityOf('loan_order_items', itemId)).toBeNull()
    expect(await facilityOf('loan_orders', orderId)).toBe(facilityId)
  }, 60_000)
})
