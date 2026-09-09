import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asEnum } from '@/lib/mapping'
import { ClientVisibleError } from '@/lib/client-visible-error'
import type { Consumable, ConsumableInput } from '@/types/order'

const CONSUMABLE_COLUMNS = 'id, facility_id, name, jan, purpose, created_at, updated_at, status'

/** 使用停止（2026-09-09）。retired は一覧と発注の選択肢から外れるが、過去の発注は残る */
const STATUSES = ['active', 'retired'] as const

/** 直そうとした消耗品が見つからない（他施設のものを含む）。route が 404 に写す */
export const CONSUMABLE_NOT_FOUND_ERROR = '消耗品が見つかりません'
/** すでに使用停止。route が 409 に写す */
export const CONSUMABLE_ALREADY_RETIRED_ERROR = 'この消耗品はすでに使用停止です'
/** 発注実績があるので削除できない。route が 409 に写す（利用者には「使用停止にしてください」と伝える） */
export const CONSUMABLE_IN_USE_ERROR = 'この消耗品は発注で使われているため削除できません。使用停止にしてください'

interface ConsumableRow {
  id?: unknown
  facility_id?: unknown
  name?: unknown
  jan?: unknown
  purpose?: unknown
  created_at?: unknown
  updated_at?: unknown
  status?: unknown
  consumable_order_items?: { count: number }[]
}

export function mapConsumable(row: ConsumableRow): Consumable {
  return {
    id: asString(row.id),
    facilityId: asString(row.facility_id),
    name: asString(row.name),
    jan: asOptionalString(row.jan),
    purpose: asString(row.purpose),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    status: asEnum(row.status, STATUSES, 'active'),
    // WHY(使われているかを一緒に返す、2026-09-09): 画面が「削除」と「使用停止」を出し分けるのに要る。
    //      応答を見てから 409 で気づかせるより、押す前に分かるほうがよい
    inUse: (row.consumable_order_items?.[0]?.count ?? 0) > 0,
  }
}

/**
 * 施設の消耗品を一覧する。
 *
 * WHY(既定で使用停止を外す、2026-09-09): 呼び出し元の多くは**発注の選択肢**として使う。
 *      止めたものが選べてしまうと止めた意味が無い。管理の画面だけが `includeRetired` を渡す。
 *      **既定を「見せる」にすると、新しい呼び出し元が黙って止めたものを混ぜる**ので、
 *      既定を安全側（外す）にしておく。
 */
export async function listConsumablesByFacility(
  db: SupabaseClient,
  facilityId: string,
  options: { includeRetired?: boolean } = {}
): Promise<Consumable[]> {
  let query = db
    .from('consumables')
    // WHY(発注実績の件数を一緒に取る): 画面が「削除」と「使用停止」を出し分けるのに要る
    .select(`${CONSUMABLE_COLUMNS}, consumable_order_items(count)`)
    .eq('facility_id', facilityId)
    .order('purpose', { ascending: true })
  if (!options.includeRetired) query = query.eq('status', 'active')

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data.map(mapConsumable)
}

export async function createConsumable(db: SupabaseClient, facilityId: string, input: ConsumableInput): Promise<Consumable> {
  const { data, error } = await db
    .from('consumables')
    .insert({ facility_id: facilityId, name: input.name, jan: input.jan ?? null, purpose: input.purpose })
    .select(CONSUMABLE_COLUMNS)
    .single()
  if (error) {
    // WHY: consumables.jan は products(jan) への FK(20260714000004_link_consumables_jan_and_validate_fk.sql)。
    //      存在しないJANを指定した場合、生のPostgresエラー(23503)をそのままthrowすると
    //      api-error.tsのtoClientErrorMessageがスキーマ情報漏洩防止のためサニタイズし、
    //      クライアント入力に起因するエラーにもかかわらず汎用500になってしまう
    //      (issue #647 レビュー指摘: FK違反時の境界条件がSPEC未記載かつ実装未対応だった)。
    //      ClientVisibleErrorとして翻訳し、route側で400として扱えるようにする。
    if (error.code === '23503') throw new ClientVisibleError('指定されたJANコードの製品が見つかりません')
    throw new Error(error.message)
  }
  return mapConsumable(data)
}

/** 施設に属する 1 件を引く。RLS は拒否ではなく 0 行にするので、0 行を「見つからない」に写す */
async function findConsumable(db: SupabaseClient, facilityId: string, id: string): Promise<ConsumableRow> {
  const { data, error } = await db
    .from('consumables')
    .select(CONSUMABLE_COLUMNS)
    .eq('id', id)
    .eq('facility_id', facilityId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new ClientVisibleError(CONSUMABLE_NOT_FOUND_ERROR)
  return data as ConsumableRow
}

/**
 * 名前・用途・JAN を直す（2026-09-09）。
 *
 * WHY: 打ち間違えたまま直せず、発注のたびに間違った名前が選ばれていた。
 *      作成と同じ入口の形（`consumableInputSchema`）を使うので、文字数の上限も同じ条件で効く。
 */
export async function updateConsumable(
  db: SupabaseClient,
  facilityId: string,
  id: string,
  input: ConsumableInput
): Promise<Consumable> {
  await findConsumable(db, facilityId, id)

  const { data, error } = await db
    .from('consumables')
    .update({ name: input.name, jan: input.jan ?? null, purpose: input.purpose })
    .eq('id', id)
    .eq('facility_id', facilityId)
    .select(CONSUMABLE_COLUMNS)
    .maybeSingle()
  if (error) {
    // 作成と同じ理由（consumables.jan は products(jan) への FK）
    if (error.code === '23503') throw new ClientVisibleError('指定されたJANコードの製品が見つかりません')
    throw new Error(error.message)
  }
  // RLS で 0 行になった場合（読めるが書けない立場＝viewer）
  if (!data) throw new ClientVisibleError('消耗品を直す権限がありません')
  return mapConsumable(data as ConsumableRow)
}

/**
 * 使用停止にする（2026-09-09）。
 *
 * WHY(削除ではない): 発注実績がある消耗品を消すと、過去の発注から品目が消える。
 *      止めるだけなら一覧と選択肢から外れ、過去の発注はそのまま残る。
 *      戻せない（DB のトリガーが `retired` からの遷移を拒む）。戻したいときは新しく登録する。
 */
export async function retireConsumable(db: SupabaseClient, facilityId: string, id: string): Promise<Consumable> {
  const current = await findConsumable(db, facilityId, id)
  if (asString(current.status) === 'retired') {
    throw new ClientVisibleError(CONSUMABLE_ALREADY_RETIRED_ERROR)
  }

  const { data, error } = await db
    .from('consumables')
    .update({ status: 'retired' })
    .eq('id', id)
    .eq('facility_id', facilityId)
    .select(CONSUMABLE_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new ClientVisibleError('消耗品を使用停止にする権限がありません')
  return mapConsumable(data as ConsumableRow)
}

/**
 * 消す（2026-09-09）。**発注実績が無いものだけ**。
 *
 * WHY(実績があるときは消さない): `consumable_order_items.consumable_id` は外部キーで、
 *      DB が 23503 で拒む。そのまま「エラー」として見せるのではなく、
 *      **「使用停止にしてください」と道を示す**（人の判断: 登録ミスは消す・廃番は止める）。
 *
 * WHY(先に実績を数える): 外部キー違反を待つと、拒まれた理由が「他の何か」かもしれない。
 *      数えてから消すことで、409 の意味を「使われている」に固定できる。
 *      数えたあとに他の人が発注する競合は残るが、そのときは DB が拒むので壊れない（同じ 409 に写す）。
 */
export async function deleteConsumable(db: SupabaseClient, facilityId: string, id: string): Promise<void> {
  await findConsumable(db, facilityId, id)

  const { count, error: countError } = await db
    .from('consumable_order_items')
    .select('id', { count: 'exact', head: true })
    .eq('consumable_id', id)
  if (countError) throw new Error(countError.message)
  if ((count ?? 0) > 0) throw new ClientVisibleError(CONSUMABLE_IN_USE_ERROR)

  const { data, error } = await db
    .from('consumables')
    .delete()
    .eq('id', id)
    .eq('facility_id', facilityId)
    .select('id')
  if (error) {
    // 数えたあとに発注された場合（競合）。DB の拒否も同じ意味に写す
    if (error.code === '23503') throw new ClientVisibleError(CONSUMABLE_IN_USE_ERROR)
    throw new Error(error.message)
  }
  // RLS で 0 行になった場合（読めるが消せない立場＝viewer）
  if ((data ?? []).length === 0) throw new ClientVisibleError('消耗品を消す権限がありません')
}
