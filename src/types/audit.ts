// WHY: issue #757 の 4 と 24。監査ログ（audit_log）と拒否の記録（access_denials）は
//      2026-09-06〜07 に入れたが、閲覧する手段が DB を直接叩くことしか無かった。
//      「誰が・いつ・何をしたか」「誰が・どこで弾かれたか」を後から説明できる状態にするには、
//      admin が画面で辿れる必要がある（security-test-catalog の E「説明できる」）。

/** 監査ログ 1 行（変更の記録） */
export interface AuditLogEntry {
  id: string
  occurredAt: string
  tableName: string
  action: string
  actorId: string | null
  actorRole: string
  facilityId: string | null
  rowId: string | null
  changedColumns: string[] | null
}

/** 拒否の記録 1 行（弾かれた操作） */
export interface AccessDenialEntry {
  id: string
  occurredAt: string
  guard: string
  reason: string
  actorId: string | null
  facilityId: string | null
  route: string | null
  method: string | null
}

/** 画面から絞り込める条件。値の妥当性は API 境界で検証する */
export interface AuditQuery {
  /** 'changes'（監査ログ）か 'denials'（拒否の記録） */
  kind: AuditKind
  facilityId?: string
  actorId?: string
  /** changes のみ。対象の表で絞る */
  tableName?: string
  /** denials のみ。どの境界で弾かれたかで絞る */
  guard?: string
  dateFrom?: string
  dateTo?: string
  limit: number
  offset: number
}

export type AuditKind = 'changes' | 'denials'

export const AUDIT_KINDS: readonly AuditKind[] = ['changes', 'denials']

export interface AuditApiResponse {
  kind: AuditKind
  changes?: AuditLogEntry[]
  denials?: AccessDenialEntry[]
}

export interface AuditApiErrorResponse {
  error: string
}
