// supabase/__tests__/integration/text-length-limits.integration.test.ts
// WHY: issue #757 の 20（入力検証）と 32（悪用耐性）。不変条件 I-060〜I-065。
//      2026-09-07 の実測では自由入力の TEXT 列に上限が 1 つも無く、術式名に 1 MB の文字列が
//      そのまま保存された（施設名 200,000 文字、JAN 5,000 文字も同じ）。
//      画面の maxlength は API を直接叩けば通るので、DB の CHECK で止める。
//      ここでは「長すぎる入力が本当に拒否される」ことと、「普通の長さは通る」ことを実 DB で固定する。

import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFacility, createServiceRoleClient } from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'
const serviceClient = createServiceRoleClient()
const run = randomUUID().slice(0, 8)
const createdFacilities: string[] = []
const createdProducts: string[] = []

const long = (n: number) => 'あ'.repeat(n)

// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-060〜I-065 入力の長さ
describe('自由入力の TEXT 列に長さの上限がある [I-060 I-061 I-062 I-063 I-064 I-065]', () => {
  let facilityId: string
  let jan: string

  beforeAll(async () => {
    const facility = await createFacility(serviceClient, `長さ上限-${run}`)
    facilityId = facility.id
    createdFacilities.push(facility.id)
    jan = `L${run}0001`
    const { data, error } = await serviceClient
      .from('products')
      .insert({ jan, ref: `REF-${run}`, name: `長さ上限テスト製品-${run}` })
      .select('id')
      .single()
    if (error || !data) throw new Error(`製品作成失敗: ${error?.message}`)
    createdProducts.push(data.id)
  }, 60_000)

  afterAll(async () => {
    for (const id of createdProducts) await serviceClient.from('products').delete().eq('id', id)
    for (const id of createdFacilities) await serviceClient.from('facilities').delete().eq('id', id)
  })

  const caseOrder = (overrides: Record<string, unknown> = {}) => ({
    facility_id: facilityId,
    case_datetime: new Date().toISOString(),
    procedure_name: '通常の術式名',
    patient_id: `PT-${run}`,
    patient_initials: 'A.B.',
    gender: 'other',
    doctor_name: '医師',
    ...overrides,
  })

  it('I-060 症例発注: 1 MB の術式名は拒否される。普通の長さは通る', async () => {
    const big = await serviceClient.from('case_orders').insert(caseOrder({ procedure_name: long(1024 * 1024) }))
    expect(big.error?.code).toBe(CHECK_VIOLATION)

    const over = await serviceClient.from('case_orders').insert(caseOrder({ procedure_name: long(201) }))
    expect(over.error?.code).toBe(CHECK_VIOLATION)

    const ok = await serviceClient.from('case_orders').insert(caseOrder({ procedure_name: long(200) })).select('id').single()
    expect(ok.error).toBeNull()
    await serviceClient.from('case_orders').delete().eq('id', ok.data!.id)
  })

  it('I-060 症例発注: 患者 ID・イニシャル・医師名にも上限がある', async () => {
    const patient = await serviceClient.from('case_orders').insert(caseOrder({ patient_id: long(101) }))
    expect(patient.error?.code).toBe(CHECK_VIOLATION)
    const initials = await serviceClient.from('case_orders').insert(caseOrder({ patient_initials: long(21) }))
    expect(initials.error?.code).toBe(CHECK_VIOLATION)
    const doctor = await serviceClient.from('case_orders').insert(caseOrder({ doctor_name: long(101) }))
    expect(doctor.error?.code).toBe(CHECK_VIOLATION)
  })

  it('I-061 短貸発注: 術式名とメーカー名に上限がある', async () => {
    const base = { facility_id: facilityId, procedure_name: '通常', maker: '通常' }
    const proc = await serviceClient.from('loan_orders').insert({ ...base, procedure_name: long(201) })
    expect(proc.error?.code).toBe(CHECK_VIOLATION)
    const maker = await serviceClient.from('loan_orders').insert({ ...base, maker: long(201) })
    expect(maker.error?.code).toBe(CHECK_VIOLATION)
  })

  it('I-062 明細: JAN とロットに上限がある', async () => {
    const { data: order } = await serviceClient.from('case_orders').insert(caseOrder()).select('id').single()
    const longJan = await serviceClient
      .from('case_order_items')
      .insert({ case_order_id: order!.id, jan: long(65), quantity: 1 })
    expect(longJan.error?.code).toBe(CHECK_VIOLATION)

    const longLot = await serviceClient
      .from('case_order_items')
      .insert({ case_order_id: order!.id, jan, lot: long(101), quantity: 1 })
    expect(longLot.error?.code).toBe(CHECK_VIOLATION)

    const ok = await serviceClient
      .from('case_order_items')
      .insert({ case_order_id: order!.id, jan, lot: 'LOT-1', quantity: 1 })
    expect(ok.error).toBeNull()
    await serviceClient.from('case_orders').delete().eq('id', order!.id)
  })

  it('I-063 消耗品: 品名 200 文字・用途 1,000 文字を超えると拒否される', async () => {
    const base = { facility_id: facilityId, name: '通常の品名', purpose: '通常の用途' }
    const name = await serviceClient.from('consumables').insert({ ...base, name: long(201) })
    expect(name.error?.code).toBe(CHECK_VIOLATION)
    const purpose = await serviceClient.from('consumables').insert({ ...base, purpose: long(1001) })
    expect(purpose.error?.code).toBe(CHECK_VIOLATION)
  })

  it('I-064 施設名: 200,000 文字は拒否される', async () => {
    const { error } = await serviceClient.from('facilities').insert({ name: long(200_000) })
    expect(error?.code).toBe(CHECK_VIOLATION)
  })

  it('I-065 マスタ: JAN 5,000 文字とカテゴリ名 201 文字は拒否される', async () => {
    const product = await serviceClient
      .from('products')
      .insert({ jan: 'J'.repeat(5000), ref: `R-${run}-x`, name: 'x' })
    expect(product.error?.code).toBe(CHECK_VIOLATION)

    const category = await serviceClient.from('categories').insert({ name: long(201) })
    expect(category.error?.code).toBe(CHECK_VIOLATION)
  })
})
