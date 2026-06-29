export type AdminUser = {
  id: string
  email: string
  lastSignInAt: string | null
  facilityIds: string[]
}

// facility.ts の Facility はフルフィールド（createdAt/updatedAt含む）を持つため、
// Admin UI では最小限フィールドのみ必要な場面があるが型互換のため再エクスポートに統一
export type { Facility } from './facility'
