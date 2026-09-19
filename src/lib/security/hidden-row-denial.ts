import { recordAccessDenial } from '@/lib/security/access-denial'
import { withJudgmentTimeout } from '@/lib/security/judgment-timeout'
import { logServerError } from '@/lib/log-safe'
import { createServiceRoleClientAccessor } from '@/lib/security/service-role-client'

// WHY(#757-24 の残り「RLS が黙って 0 件を返す拒否」、2026-09-13): ID 指定で 1 件取る route は
//      RLS で見えない行を「存在しない」と区別できず、404 を返すだけで痕跡が残らなかった
//      （P-063 の限界欄）。一覧は requireFacilityAccess が先に 403 を記録するので、この穴は
//      ID 指定の 1 件取得（facilities / hospital_prices）にしか無い（2026-09-13 に読み取り経路を
//      棚卸しして確認）。
//
// WHY(service_role で存在だけ確かめる): RLS の述語関数（is_facility_member 等）は STABLE で
//      INSERT できず、DB 側では「見えなかった」を数えられない。代わりに、0 件だったときだけ
//      service_role で「行があるか」を 1 回だけ見る。読むのは facility_id だけで、行の中身は
//      呼び出し元に返さない（応答は 404 のまま。存在の有無を漏らさない）。
//
// WHY(reason は forbidden で足りる): aal1 の利用者は proxy の MFA ガードが /api に届く前に
//      /mfa-challenge へ送るので、この route に来て RLS で隠れる理由は「所属していない」か
//      「admin でない」に限られる。直接 PostgREST を叩く経路（X-0xx）は対象外。
//
// WHY(fail-open): 記録は証跡であって拒否ではない。存在確認が失敗・タイムアウトしたら記録しない
//      （誤記録より漏れを選ぶ）。例外は飲み込んで logServerError に残す。
//      docs/agents/privileged-write-rulebook.md の W-023。

// WHY(case_orders・loan_returns、issue #809): GET /api/case-orders/[id]・GET /api/loan-returns/[id]
//      も「ID指定で1件取る」経路なので、facilities/hospital_pricesと同じ穴（RLSが黙って0件を
//      返す拒否）を持つ。SPEC.md Part2 受け入れ条件に従い、この表に足す
export type HiddenRowTable = 'facilities' | 'hospital_prices' | 'case_orders' | 'loan_returns'

export interface HiddenRowDenial {
  table: HiddenRowTable
  /** 要求された行の ID（uuid でない値も来る。その場合は「無い」扱い） */
  id: string
  actorId: string
}

// WHY(共有ヘルパー、issue #793): ここは 2026-09-19 まで**env 未設定時に黙って null を返して**
//      いた。上の WHY が「例外は飲み込んで logServerError に残す」と宣言しているのに、
//      env が無い経路だけログが無く、記録がまるごと落ちていた。
//      同じコピペが 4 ファイルにあったので service-role-client.ts へ一本化した。
const client = createServiceRoleClientAccessor('hidden_row_denial_client_unavailable')

/** 行があればその facility_id、無ければ・判定できなければ null */
async function lookupFacilityId(
  db: NonNullable<ReturnType<typeof client.get>>,
  table: HiddenRowTable,
  id: string
): Promise<string | null> {
  if (table === 'facilities') {
    const { data, error } = await db.from('facilities').select('id').eq('id', id).maybeSingle()
    if (error || !data) return null
    return data.id
  }
  const { data, error } = await db.from(table).select('facility_id').eq('id', id).maybeSingle()
  if (error || !data) return null
  return data.facility_id
}

export async function recordHiddenRowDenial(input: HiddenRowDenial): Promise<void> {
  try {
    const db = client.get()
    if (!db) return
    const facilityId = await withJudgmentTimeout<string | null>(
      'hidden-row.exists',
      () => lookupFacilityId(db, input.table, input.id),
      () => null,
    )
    if (!facilityId) return
    await recordAccessDenial({ guard: 'facility', reason: 'forbidden', actorId: input.actorId, facilityId })
  } catch (error) {
    logServerError('hidden_row_denial_skip', error)
  }
}
