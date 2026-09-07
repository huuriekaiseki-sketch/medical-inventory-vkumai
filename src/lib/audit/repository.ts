import type { SupabaseClient } from '@supabase/supabase-js'
import { asNullableString, asString } from '@/lib/mapping'
import { jstDayEnd, jstDayStart } from '@/lib/jst-date-range'
import type { AccessDenialEntry, AuditLogEntry, AuditQuery } from '@/types/audit'

// WHY: issue #757 の 4・24。監査ログと拒否の記録を画面から辿れるようにする層。
//
// WHY(RLS に任せる): どちらの表も RLS で「admin だけが読める」（拒否の記録は aal2 も要る）。
//      ここでは SECURITY DEFINER の RPC を作らず、呼び出し元のセッションのまま SELECT する。
//      境界の判断を DB の 1 か所に残したままにするため（known-failure-patterns の
//      「SECURITY DEFINER + GRANT EXECUTE の認可バイパス」を増やさない）。
//
// WHY(古い順ではなく新しい順): 事故のあとに見るので、直近が先に要る。

function mapAuditRow(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: asString(row.id),
    occurredAt: asString(row.occurred_at),
    tableName: asString(row.table_name),
    action: asString(row.action),
    actorId: asNullableString(row.actor_id),
    actorRole: asString(row.actor_role),
    facilityId: asNullableString(row.facility_id),
    rowId: asNullableString(row.row_id),
    changedColumns: Array.isArray(row.changed_columns) ? row.changed_columns.map(String) : null,
  }
}

function mapDenialRow(row: Record<string, unknown>): AccessDenialEntry {
  return {
    id: asString(row.id),
    occurredAt: asString(row.occurred_at),
    guard: asString(row.guard),
    reason: asString(row.reason),
    actorId: asNullableString(row.actor_id),
    facilityId: asNullableString(row.facility_id),
    route: asNullableString(row.route),
    method: asNullableString(row.method),
  }
}

/**
 * 変更の記録（audit_log）を新しい順に取得する。
 *
 * WHY(old_data / new_data を返さない): 行の中身には患者 ID・術式名が入る（issue #757 の 5 と
 * 同じ理由）。一覧では「どの表のどの行のどの列が変わったか」までで足り、中身は要らない。
 * 中身が要る調査は DB 側で行う（そこには admin しか届かない）。
 */
export async function listAuditLog(db: SupabaseClient, query: AuditQuery): Promise<AuditLogEntry[]> {
  let q = db
    .from('audit_log')
    .select('id, occurred_at, table_name, action, actor_id, actor_role, facility_id, row_id, changed_columns')
    .order('occurred_at', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1)

  if (query.facilityId) q = q.eq('facility_id', query.facilityId)
  if (query.actorId) q = q.eq('actor_id', query.actorId)
  if (query.tableName) q = q.eq('table_name', query.tableName)
  if (query.dateFrom) q = q.gte('occurred_at', jstDayStart(query.dateFrom))
  if (query.dateTo) q = q.lte('occurred_at', jstDayEnd(query.dateTo))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((row) => mapAuditRow(row as Record<string, unknown>))
}

/** 拒否の記録（access_denials）を新しい順に取得する。読めるのは aal2 の admin だけ（RLS） */
export async function listAccessDenials(
  db: SupabaseClient,
  query: AuditQuery
): Promise<AccessDenialEntry[]> {
  let q = db
    .from('access_denials')
    .select('id, occurred_at, guard, reason, actor_id, facility_id, route, method')
    .order('occurred_at', { ascending: false })
    .range(query.offset, query.offset + query.limit - 1)

  if (query.facilityId) q = q.eq('facility_id', query.facilityId)
  if (query.actorId) q = q.eq('actor_id', query.actorId)
  if (query.guard) q = q.eq('guard', query.guard)
  if (query.dateFrom) q = q.gte('occurred_at', jstDayStart(query.dateFrom))
  if (query.dateTo) q = q.lte('occurred_at', jstDayEnd(query.dateTo))

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((row) => mapDenialRow(row as Record<string, unknown>))
}
