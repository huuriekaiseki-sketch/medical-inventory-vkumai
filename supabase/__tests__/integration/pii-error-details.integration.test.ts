// supabase/__tests__/integration/pii-error-details.integration.test.ts
// WHY: issue #757 の 5。「PostgreSQL のエラーには行の中身が入る」は仕様書の記述ではなく、本物の DB で
//      実測して初めて確かになる。ここでは症例発注（患者 ID・イニシャル・医師名を持つ）を CHECK 違反で
//      失敗させ、PostgREST が返す生のエラーに患者 ID が**入っている**ことと、redactForLog を通すと
//      **消える**ことの両方を見る。前者が落ちたら「漏れる前提が変わった」合図で、後者が落ちたら伏せ漏れ。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'
import { redactForLog } from '@/lib/log-safe'

const PATIENT_ID = 'PT-SECRET-4242'
const DOCTOR = '伏せ字テスト医師'

describe('DB エラーの DETAIL に入る患者情報を、ログに出す前に伏せる（issue #757 の 5）', () => {
  let fx: SeedHospitalPricesRlsIdorFixtures

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  it('CHECK 違反（gender）の生エラーには患者 ID が含まれ、redactForLog を通すと消える', async () => {
    const { error } = await fx.userA.client.rpc('create_case_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: '伏せ字テスト',
      p_patient_id: PATIENT_ID,
      p_patient_initials: 'X.Y.',
      p_gender: 'unknown', // CHECK (gender IN ('male','female','other')) に違反
      p_doctor_name: DOCTOR,
      p_items: [],
    })
    expect(error?.code).toBe('23514')

    // 前提の実測: 生のエラー（PostgREST の details）には行の中身がそのまま入っている
    const raw = JSON.stringify(error)
    expect(raw).toContain(PATIENT_ID)
    expect(raw).toContain(DOCTOR)

    // 伏せた後: 患者 ID・医師名が消え、code と伏せた message だけが残る
    const safe = JSON.stringify(redactForLog(error))
    expect(safe).not.toContain(PATIENT_ID)
    expect(safe).not.toContain(DOCTOR)
    expect(safe).toContain('23514')
  })
})
