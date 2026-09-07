'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatJstDateTime } from '@/lib/format-date'
import type { AccessDenialEntry, AuditKind, AuditLogEntry } from '@/types/audit'

// WHY: issue #757 の 4・24。監査ログ（変更の記録）と拒否の記録は DB に貯まっていたが、
//      読む手段が DB を直接叩くことしか無かった。事故のあとに説明できる状態にするための画面。
//      認可は proxy の admin ガードと API 側の 403 に委ね、この画面自体は持たない
//      （/admin 配下の他ページと同じ）。

const KIND_LABEL: Record<AuditKind, string> = {
  changes: '変更の記録',
  denials: '拒否された操作',
}

const ACTION_LABEL: Record<string, string> = {
  INSERT: '作成',
  UPDATE: '更新',
  DELETE: '削除',
}

const GUARD_LABEL: Record<string, string> = {
  auth: '認証',
  facility: '施設の境界',
  admin: '管理者の境界',
  proxy_admin: '管理画面の入口',
  rate_limit: '回数の上限',
}

const REASON_LABEL: Record<string, string> = {
  unauthenticated: '未認証',
  facility_id_required: '施設が未指定',
  forbidden: '権限がない',
  not_admin: '管理者でない',
  rate_limited: '回数の上限を超えた',
}

function AuditPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const kind = (searchParams.get('kind') === 'denials' ? 'denials' : 'changes') as AuditKind
  const dateFrom = searchParams.get('date_from') ?? ''
  const dateTo = searchParams.get('date_to') ?? ''
  const actorId = searchParams.get('actor_id') ?? ''
  const facilityId = searchParams.get('facility_id') ?? ''

  const [changes, setChanges] = useState<AuditLogEntry[]>([])
  const [denials, setDenials] = useState<AccessDenialEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ kind })
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo) params.set('date_to', dateTo)
        if (actorId) params.set('actor_id', actorId)
        if (facilityId) params.set('facility_id', facilityId)
        const res = await fetch(`/api/admin/audit?${params.toString()}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setChanges(data.changes ?? [])
        setDenials(data.denials ?? [])
      } catch {
        if (!cancelled) setError('監査ログの取得に失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [kind, dateFrom, dateTo, actorId, facilityId])

  function pushQuery(next: Record<string, string>) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value)
    }
    const query = params.toString()
    router.push(query ? `/admin/audit?${query}` : '/admin/audit')
  }

  return (
    <div>
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-1"
          style={{ color: '#B03F00', fontFamily: 'var(--font-oswald), sans-serif' }}
        >
          Audit
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
        >
          監査ログ
        </h1>
        <p className="mt-2 text-sm" style={{ color: '#4B5563' }}>
          変更の記録は誰が何を書き換えたか、拒否された操作は誰がどこで弾かれたかを新しい順に表示します。
          行の中身（患者 ID・術式名など）は表示しません。
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {(['changes', 'denials'] as AuditKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => pushQuery({ kind: k, date_from: dateFrom, date_to: dateTo, actor_id: actorId, facility_id: facilityId })}
            aria-pressed={kind === k}
            className="rounded px-4 py-2 text-sm font-medium"
            style={
              kind === k
                ? { backgroundColor: '#072C2C', color: '#FFFFFF' }
                : { backgroundColor: '#FFFFFF', color: '#072C2C', border: '1px solid #E5E7EB' }
            }
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <form
        className="mb-6 flex flex-wrap items-end gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          pushQuery({
            kind,
            date_from: String(form.get('date_from') ?? ''),
            date_to: String(form.get('date_to') ?? ''),
            actor_id: String(form.get('actor_id') ?? ''),
            facility_id: String(form.get('facility_id') ?? ''),
          })
        }}
      >
        <label className="flex flex-col text-sm" style={{ color: '#4B5563' }}>
          開始日
          <input type="date" name="date_from" defaultValue={dateFrom} className="mt-1 rounded border px-3 py-2" style={{ borderColor: '#E5E7EB' }} />
        </label>
        <label className="flex flex-col text-sm" style={{ color: '#4B5563' }}>
          終了日
          <input type="date" name="date_to" defaultValue={dateTo} className="mt-1 rounded border px-3 py-2" style={{ borderColor: '#E5E7EB' }} />
        </label>
        <label className="flex flex-col text-sm" style={{ color: '#4B5563' }}>
          利用者 ID
          <input type="text" name="actor_id" defaultValue={actorId} placeholder="UUID" className="mt-1 rounded border px-3 py-2" style={{ borderColor: '#E5E7EB' }} />
        </label>
        <label className="flex flex-col text-sm" style={{ color: '#4B5563' }}>
          施設 ID
          <input type="text" name="facility_id" defaultValue={facilityId} placeholder="UUID" className="mt-1 rounded border px-3 py-2" style={{ borderColor: '#E5E7EB' }} />
        </label>
        <button type="submit" className="rounded px-4 py-2 text-sm font-medium" style={{ backgroundColor: '#FF5F03', color: '#FFFFFF' }}>
          絞り込む
        </button>
      </form>

      {loading && <p className="text-sm" style={{ color: '#4B5563' }}>読み込み中…</p>}
      {error && <p className="text-sm" role="alert" style={{ color: '#B91C1C' }}>{error}</p>}

      {!loading && !error && kind === 'changes' && (
        changes.length === 0 ? (
          <p className="text-sm" style={{ color: '#4B5563' }}>該当する記録はありません。</p>
        ) : (
          <div className="overflow-x-auto rounded bg-white shadow-sm" style={{ border: '1px solid #E5E7EB' }}>
            <table className="min-w-full text-sm">
              <caption className="sr-only">変更の記録</caption>
              <thead>
                <tr style={{ backgroundColor: '#F9FAFB' }}>
                  <th scope="col" className="px-4 py-3 text-left">日時</th>
                  <th scope="col" className="px-4 py-3 text-left">対象</th>
                  <th scope="col" className="px-4 py-3 text-left">操作</th>
                  <th scope="col" className="px-4 py-3 text-left">実行者</th>
                  <th scope="col" className="px-4 py-3 text-left">変わった列</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((row) => (
                  <tr key={row.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatJstDateTime(row.occurredAt)}</td>
                    <td className="px-4 py-3">{row.tableName}</td>
                    <td className="px-4 py-3">{ACTION_LABEL[row.action] ?? row.action}</td>
                    <td className="px-4 py-3">{row.actorId ?? `（${row.actorRole}）`}</td>
                    <td className="px-4 py-3">{row.changedColumns?.join(', ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {!loading && !error && kind === 'denials' && (
        denials.length === 0 ? (
          <p className="text-sm" style={{ color: '#4B5563' }}>
            該当する記録はありません。二要素認証まで進めていない管理者にはここが常に空になります。
          </p>
        ) : (
          <div className="overflow-x-auto rounded bg-white shadow-sm" style={{ border: '1px solid #E5E7EB' }}>
            <table className="min-w-full text-sm">
              <caption className="sr-only">拒否された操作</caption>
              <thead>
                <tr style={{ backgroundColor: '#F9FAFB' }}>
                  <th scope="col" className="px-4 py-3 text-left">日時</th>
                  <th scope="col" className="px-4 py-3 text-left">境界</th>
                  <th scope="col" className="px-4 py-3 text-left">理由</th>
                  <th scope="col" className="px-4 py-3 text-left">利用者</th>
                  <th scope="col" className="px-4 py-3 text-left">経路</th>
                </tr>
              </thead>
              <tbody>
                {denials.map((row) => (
                  <tr key={row.id} style={{ borderTop: '1px solid #E5E7EB' }}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatJstDateTime(row.occurredAt)}</td>
                    <td className="px-4 py-3">{GUARD_LABEL[row.guard] ?? row.guard}</td>
                    <td className="px-4 py-3">{REASON_LABEL[row.reason] ?? row.reason}</td>
                    <td className="px-4 py-3">{row.actorId ?? '（未認証）'}</td>
                    <td className="px-4 py-3">{row.route ? `${row.method ?? ''} ${row.route}`.trim() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}

export default function AuditPage() {
  return (
    <Suspense fallback={<p className="text-sm">読み込み中…</p>}>
      <AuditPageInner />
    </Suspense>
  )
}
