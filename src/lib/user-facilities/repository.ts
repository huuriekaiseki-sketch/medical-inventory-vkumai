import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asEnum } from '@/lib/mapping'
import type { UserFacilityMembership } from '@/types/dashboard'
import { FACILITY_ROLES, type FacilityRole } from '@/types/role'

interface UserFacilityRow {
  facility_id?: unknown
  role?: unknown
  facilities?: { name?: unknown } | null
}

/**
 * RPC/クエリ行を UserFacilityMembership 型にマッピングする
 * role は不正値の場合 'staff' にフォールバックする（安全側に倒す）
 */
export function mapUserFacilityMembership(row: UserFacilityRow): UserFacilityMembership {
  return {
    facilityId: asString(row.facility_id),
    facilityName: asString(row.facilities?.name),
    role: asEnum(row.role, FACILITY_ROLES, 'staff'),
  }
}

/**
 * ユーザーが所属する施設一覧（role付き）を取得する
 * user_facilities の RLS（self_read）により auth.uid() の行のみ取得可能
 */
export async function listUserFacilities(
  db: SupabaseClient,
  userId: string
): Promise<UserFacilityMembership[]> {
  const { data, error } = await db
    .from('user_facilities')
    .select('facility_id, role, facilities(name)')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as UserFacilityRow[]).map(mapUserFacilityMembership)
}

/**
 * 指定施設におけるユーザー自身のroleを取得する（UIゲーティング用）。
 * user_facilities の RLS（self_read）により auth.uid() の行のみ取得可能。
 * 未所属の場合は null（呼び出し元はis_admin判定と合わせて扱うこと）。
 */
export async function getUserFacilityRole(
  db: SupabaseClient,
  userId: string,
  facilityId: string
): Promise<FacilityRole | null> {
  const { data, error } = await db
    .from('user_facilities')
    .select('role')
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return asEnum(data.role, FACILITY_ROLES, 'staff')
}
