// supabase/__tests__/integration/case-orders-rls-idor.integration.test.ts
// WHY: loan-orders-rls-idor.integration.test.ts（issue #165）と同じ手法で、
//      case_orders でも「施設Bのユーザーが施設Aの症例発注にアクセスできない」ことを
//      本物のローカルSupabaseへの接続を伴って確認する（issue #315: 他テーブルへの横展開）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupCaseOrdersRlsIdorFixtures,
  seedCaseOrdersRlsIdorFixtures,
  type SeedCaseOrdersRlsIdorFixtures,
} from './helpers/seed-rls-idor'

describe('case_orders RLS/IDOR (issue #315)', () => {
  let fixtures: SeedCaseOrdersRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedCaseOrdersRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupCaseOrdersRlsIdorFixtures(fixtures)
    }
  })

  it('ユーザーBは施設Aのcase_ordersを1件も取得できない', async () => {
    const { data, error } = await fixtures.userB.client
      .from('case_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('ユーザーBは施設Aに対してcreate_case_order_atomicを呼ぶと拒否される', async () => {
    const { data, error } = await fixtures.userB.client.rpc('create_case_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: 'IDORテスト術式',
      p_patient_id: 'IDOR-TEST-PATIENT-0001',
      p_patient_initials: 'IDORテスト患者',
      p_gender: 'other',
      p_doctor_name: 'IDORテスト医師',
      p_items: [],
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('ユーザーAは自分の施設Aのcase_ordersを取得でき、シード済みの1件が含まれる', async () => {
    const { data, error } = await fixtures.userA.client
      .from('case_orders')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((row) => row.id === fixtures.caseOrderA.id)).toBe(true)
  })

  it('ユーザーAは自分の施設Aに対してcreate_case_order_atomicを呼ぶと成功する', async () => {
    const { data, error } = await fixtures.userA.client.rpc('create_case_order_atomic', {
      p_facility_id: fixtures.facilityA.id,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: '正常系テスト術式',
      p_patient_id: 'NORMAL-TEST-PATIENT-0001',
      p_patient_initials: '正常系テスト患者',
      p_gender: 'other',
      p_doctor_name: '正常系テスト医師',
      p_items: [],
    })

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect((data as { facility_id?: string })?.facility_id).toBe(fixtures.facilityA.id)
  })
})
