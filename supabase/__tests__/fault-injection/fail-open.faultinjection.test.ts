// supabase/__tests__/fault-injection/fail-open.faultinjection.test.ts
//
// WHY: issue #757 の 31（fail-open）。棚卸し（docs/agents/fail-open-inventory.md）は 19 行あるが、
//      **実際に依存を止めて測ったのは 1 行だけ**で、残りはコードを読んだ判断だった。
//
//      静的検査（scripts/check-fail-open.test.sh）が見られるのは「`error` を受け取っているか」まで。
//      **そもそも `error` として返ってくるのか、それとも throw されるのか**は本物を止めないと分からない。
//      ここが食い違うと `error || !user` の行は一度も実行されず、catch の有無が結果を決める。
//      単体テストはモックで `{ data: null, error }` を返しているので、**その前提が正しいかは測っていない**。
//
// 測るもの: 制御点ごとに「拒否したか」ではなく **どう失敗したか**（戻り値の error / 例外）を記録する。
//
// **CI では回さない。** docker のコンテナを止めるので、`bash scripts/measure-fail-open.sh` から
// 人が起動する（test-matrix の「障害注入（外部依存停止）」＝節目）。
// 途中で落ちても afterAll と wrapper が必ずコンテナを戻す。

import { execFileSync } from 'child_process'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import {
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  type SeededUser,
} from '../integration/helpers/seed-rls-idor'

const PROJECT = 'medical-inventory-vkumai'
const REST = `supabase_rest_${PROJECT}`
const AUTH = `supabase_auth_${PROJECT}`

function docker(action: 'stop' | 'start', container: string): void {
  execFileSync('docker', [action, container], { stdio: 'pipe', timeout: 60_000 })
}

/** 止めたあと、実際に応答しなくなるまで待つ（止めた直後は接続が残っていることがある） */
async function settle(ms = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

type Outcome = {
  /** 拒否側に倒れたか（例外を投げた、または false を返した） */
  denied: boolean
  /** どう失敗したか。'throw' なら例外、'value' なら戻り値で判断された */
  how: 'throw' | 'value'
  detail: string
  /** かかった時間（ミリ秒）。**拒否しても遅ければ実行時間を食い潰す**ので一緒に測る */
  ms: number
}

async function observe(label: string, fn: () => Promise<unknown>): Promise<Outcome> {
  const t0 = Date.now()
  try {
    const v = await fn()
    const ms = Date.now() - t0
    const denied = v === false
    console.log(`  ${label}: ${denied ? '拒否' : '通した'}（戻り値） returned ${JSON.stringify(v)} / ${ms} ms`)
    return { denied, how: 'value', detail: `returned ${JSON.stringify(v)}`, ms }
  } catch (e) {
    const ms = Date.now() - t0
    const detail = e instanceof Error ? e.message : String(e)
    console.log(`  ${label}: 拒否（例外） ${detail} / ${ms} ms`)
    return { denied: true, how: 'throw', detail, ms }
  }
}

/** コンテナを起動し直したあと、実際に応答が返るまで待つ（3 秒では足りないことがある） */
async function waitUntilAuthReady(client: SupabaseClient, timeoutMs = 60_000): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const { error } = await client.auth.getUser()
    if (!error) return Date.now() - t0
    if (Date.now() - t0 > timeoutMs) throw new Error(`Auth が ${timeoutMs} ms で戻らない: ${error.message}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

describe('依存を止めたときにどちら側へ倒れるか（fail-open の実測） [F-001][F-002][F-003][F-004]', () => {
  const service = createServiceRoleClient()
  let facility: { id: string; name: string }
  let otherFacility: { id: string; name: string }
  let user: SeededUser
  let db: SupabaseClient
  let authUser: User

  beforeAll(async () => {
    facility = await createFacility(service, `fail-open-${Date.now()}`)
    otherFacility = await createFacility(service, `fail-open-other-${Date.now()}`)
    user = await createSeededUser(service, 'fail-open', facility.id, 'staff')
    db = user.client
    const { data } = await db.auth.getUser()
    if (!data.user) throw new Error('サインインできていない')
    authUser = data.user
  }, 120_000)

  afterAll(async () => {
    // **何があっても戻す。** 止めっぱなしにすると以後のすべての作業が壊れる
    for (const c of [REST, AUTH]) {
      try { docker('start', c) } catch { /* すでに起動している */ }
    }
    await settle(2000)
    if (user) await service.auth.admin.deleteUser(user.id)
    for (const f of [facility, otherFacility]) {
      if (f) await service.from('facilities').delete().eq('id', f.id)
    }
  }, 120_000)

  it('平常時: 認証・admin 判定・施設判定がすべて通る（基準）', async () => {
    const auth = await observe('requireAuth', () => requireAuth(db))
    const admin = await observe('resolveIsAdmin', () => resolveIsAdmin(db, authUser))
    const facilityOk = await observe('requireFacilityAccess(自施設)', () =>
      requireFacilityAccess(db, authUser, facility.id),
    )
    expect(auth.denied, '平常時に認証が拒否された（基準が取れていない）').toBe(false)
    expect(admin.detail).toBe('returned false') // staff なので false が正しい
    expect(facilityOk.denied, '平常時に自施設が拒否された（基準が取れていない）').toBe(false)
  })

  it('平常時: 他施設は拒否される（拒否の側も動いていることの確認）', async () => {
    const other = await observe('requireFacilityAccess(他施設)', () =>
      requireFacilityAccess(db, authUser, otherFacility.id),
    )
    expect(other.denied).toBe(true)
    expect(other.detail).toContain('FORBIDDEN')
  })

  it('PostgREST を止める: RPC を使う判定は拒否側へ倒れる', async () => {
    docker('stop', REST)
    await settle()
    try {
      const admin = await observe('resolveIsAdmin', () => resolveIsAdmin(db, authUser))
      const facilityAccess = await observe('requireFacilityAccess(自施設)', () =>
        requireFacilityAccess(db, authUser, facility.id),
      )
      const auth = await observe('requireAuth', () => requireAuth(db))

      // admin 判定が「通す」側へ倒れたら、非 admin が全施設に届く
      expect(admin.denied, 'PostgREST 停止中に admin 判定が通した').toBe(true)
      // 施設判定が通ると他施設のデータに届く
      expect(facilityAccess.denied, 'PostgREST 停止中に施設判定が通した').toBe(true)
      // requireAuth は Auth（GoTrue）が生きているので通るのが設計
      // （回数の上限だけが数えられず、fail-open で通す。F-019）
      expect(auth.denied, 'PostgREST 停止中に認証が拒否された（設計と違う）').toBe(false)

      // WHY(拒否しても遅ければ困る): 判定が拒否側へ倒れても、そこまでに何十秒もかかると
      //      サーバーレス関数の実行時間を食い潰し、可用性の穴になる。**時間も一緒に測る**
      console.log(`  かかった時間: admin=${admin.ms}ms facility=${facilityAccess.ms}ms auth=${auth.ms}ms`)
    } finally {
      docker('start', REST)
      await settle(3000)
    }
  })

  it('GoTrue を止める: 認証は拒否側へ倒れる', async () => {
    docker('stop', AUTH)
    await settle()
    try {
      const auth = await observe('requireAuth', () => requireAuth(db))
      const raw = await db.auth.getUser()
      console.log(`  getUser の失敗の届き方: ${raw.error ? '戻り値の error' : '**error が来ない**'} ${raw.error?.message ?? ''}`)
      const mfa = await observe('mfa.getAuthenticatorAssuranceLevel', async () => {
        const r = await db.auth.mfa.getAuthenticatorAssuranceLevel()
        // proxy.ts（F-004）は error || !aal を拒否にする。同じ判定をここで再現する
        return !(r.error || !r.data?.currentLevel)
      })

      expect(auth.denied, 'GoTrue 停止中に認証が通った').toBe(true)
      // **例外ではなく戻り値の error で来ることが F-001 の前提**。ここが変わると
      // `error || !user` の行が実行されず、catch の有無が結果を決める
      expect(raw.error, 'getUser が error を返さなかった（前提が崩れている）').not.toBeNull()

      // WHY(2026-09-08 の実測で分かったこと): `getAuthenticatorAssuranceLevel()` は
      //      **GoTrue を呼ばない**。手元の JWT の aal クレームを読むだけなので、
      //      GoTrue が落ちていても即座に値を返す（下の ms がほぼ 0）。
      //      つまり F-004 の「止まるもの」は Auth API ではなく**トークンそのもの**で、
      //      棚卸しの依存の書き方が実態と違っていた。
      //      これは穴ではない（aal2 のトークンを持っている人が通るのは正しい）が、
      //      「Auth が落ちたら MFA ガードが閉じる」という読み方は誤り。
      expect(mfa.detail, 'MFA 判定が GoTrue の停止で失敗した（実測と違う）').toBe('returned true')
      expect(mfa.ms, 'MFA 判定がネットワークを待っている（手元の JWT を読んでいない）').toBeLessThan(1000)
    } finally {
      docker('start', AUTH)
    }
  })

  it('止めたあと復旧すると平常時に戻る（測定が環境を壊していない）', async () => {
    // WHY: 停止から復帰した直後は数秒では応答しない。決め打ちで待つと
    //      「復旧しない」という誤った結論になる（初回の測定で実際に起きた）
    const waited = await waitUntilAuthReady(db)
    console.log(`  Auth が応答を返すまで: ${waited} ms`)
    const auth = await observe('requireAuth', () => requireAuth(db))
    expect(auth.denied, '復旧後も拒否されたまま（環境が壊れている）').toBe(false)
  })
})
