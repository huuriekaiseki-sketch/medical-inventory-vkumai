'use client'

import { useEffect, useState } from 'react'
import type { FacilityRole } from '@/types/role'

export type UseFacilityRoleResult = {
  // WHY: undefinedは取得中(プレースホルダ表示用)、nullは未所属(admin以外書き込み不可)。
  role: FacilityRole | null | undefined
  canWrite: boolean
  isLoading: boolean
}

// WHY: 施設ごとのUIゲーティング(issue #608)を各ページが個別に配線すると、新しい
// 書き込みページを作る際に配線を忘れて「viewerに操作できそうなボタンが見える」が
// 再発しうる(issue #618)。GET /api/facilities/[id]/my-role の呼び出し・
// 取得中/未所属/エラーのハンドリング・canWrite判定を1箇所にまとめる。
//
// 対象は「1つのfacilityIdに対する自分のroleが分かれば良い」ページ(施設詳細ページ、
// 対象施設が確定した後の編集ページ等)。hospital-prices/newのように施設選択自体が
// フォーム内で行われ、複数施設の書き込み可否を同時に知る必要があるページは対象外
// (GET /api/facilities の roleByFacilityId をそのまま使う。この場合my-roleへの
// 個別リクエストをfacility数だけ発行するのは非効率なため意図的に分離している)。
//
// SWR等のキャッシュライブラリは導入せず、素のfetch+useStateで実装している
// (このリポジトリの既存ページも同パターンで新規依存を増やす理由が無いため)。
type FetchedState = { facilityId: string; role: FacilityRole | null }

export function useFacilityRole(facilityId: string | null | undefined): UseFacilityRoleResult {
  const [state, setState] = useState<FetchedState | null>(null)

  useEffect(() => {
    if (!facilityId) return
    let cancelled = false
    fetch(`/api/facilities/${facilityId}/my-role`)
      .then((r) => {
        if (!r.ok) throw new Error()
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setState({ facilityId, role: d.role })
      })
      .catch(() => {
        if (!cancelled) setState({ facilityId, role: null })
      })
    return () => {
      cancelled = true
    }
  }, [facilityId])

  if (!facilityId) {
    return { role: null, canWrite: false, isLoading: false }
  }

  // WHY: facilityIdが切り替わった直後、stateはまだ前のfacilityId分のまま(effect内
  // でのsetStateは非同期コールバック内でのみ行い、切り替わり検知のための同期的な
  // リセットは行わない)。ここでレンダー時にstate.facilityIdと現在のfacilityIdを
  // 突き合わせ、一致しない間は「取得中」として扱う。
  const isStale = state === null || state.facilityId !== facilityId
  const role = isStale ? undefined : state.role

  return {
    role,
    canWrite: role === 'admin' || role === 'staff',
    isLoading: isStale,
  }
}
