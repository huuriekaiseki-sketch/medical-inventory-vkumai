// 施設スコープのデータを大量に作って、一覧・明細・施設削除の所要時間を測る（issue #757 の 19）。
// 起動は scripts/measure-scale.sh 経由（ローカル以外へ向けないガードがそちらにある）。
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const db = createClient(url, process.env.SERVICE_KEY, { auth: { persistSession: false } })

const ORDERS = Number(process.env.ORDERS ?? 3000)
const ITEMS_PER_ORDER = Number(process.env.ITEMS_PER_ORDER ?? 3)
const run = randomUUID().slice(0, 8)

const ms = async (label, fn) => {
  const t = Date.now()
  const r = await fn()
  const d = Date.now() - t
  console.log(`${label}: ${d} ms`)
  return { d, r }
}

const { data: facility } = await db.from('facilities').insert({ name: `性能計測-${run}` }).select('id').single()
const facilityId = facility.id
const { data: product } = await db
  .from('products')
  .insert({ jan: `19${run}0000`, ref: `REF-19-${run}`, name: `性能計測製品-${run}` })
  .select('id, jan')
  .single()

console.log(`件数: 発注 ${ORDERS} / 明細 ${ORDERS * ITEMS_PER_ORDER}`)

await ms('発注の一括作成', async () => {
  for (let i = 0; i < ORDERS; i += 500) {
    const rows = []
    for (let j = i; j < Math.min(i + 500, ORDERS); j++) {
      rows.push({
        facility_id: facilityId,
        case_datetime: new Date(Date.now() - j * 60000).toISOString(),
        procedure_name: `手技-${j}`,
        patient_id: `PT-${run}-${j}`,
        patient_initials: 'A.B.',
        gender: 'other',
        doctor_name: '医師',
      })
    }
    const { error } = await db.from('case_orders').insert(rows)
    if (error) throw new Error('発注作成: ' + error.message)
  }
})

// PostgREST は既定で 1000 行までしか返さないので、range でページングして全件取る
const orderIds = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('case_orders')
    .select('id')
    .eq('facility_id', facilityId)
    .range(from, from + 999)
  if (error) throw new Error('発注 ID 取得: ' + error.message)
  orderIds.push(...data)
  if (data.length < 1000) break
}
console.log('明細を作る対象の発注 ID:', orderIds.length, '件')
await ms('明細の一括作成', async () => {
  for (let i = 0; i < orderIds.length; i += 300) {
    const rows = []
    for (const o of orderIds.slice(i, i + 300)) {
      for (let k = 0; k < ITEMS_PER_ORDER; k++) {
        rows.push({ case_order_id: o.id, jan: product.jan, quantity: 1, unit_price: 100 })
      }
    }
    const { error } = await db.from('case_order_items').insert(rows)
    if (error) throw new Error('明細作成: ' + error.message)
  }
})


console.log('--- 計測 ---')
await ms('一覧: 施設の発注 50 件（新しい順）', async () => {
  const { error } = await db
    .from('case_orders')
    .select('id, case_datetime, procedure_name')
    .eq('facility_id', facilityId)
    .order('case_datetime', { ascending: false })
    .limit(50)
  if (error) throw new Error(error.message)
})

const sample = orderIds[Math.floor(orderIds.length / 2)]
await ms('明細: 1 発注の明細を引く', async () => {
  const { error } = await db.from('case_order_items').select('id, jan, quantity').eq('case_order_id', sample.id)
  if (error) throw new Error(error.message)
})

await ms('施設削除（明細まで CASCADE）', async () => {
  const { error } = await db.from('facilities').delete().eq('id', facilityId)
  if (error) throw new Error(error.message)
})

await db.from('products').delete().eq('id', product.id)
console.log('後片付け完了')
