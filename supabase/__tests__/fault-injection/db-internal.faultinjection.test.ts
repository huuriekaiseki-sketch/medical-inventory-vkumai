// supabase/__tests__/fault-injection/db-internal.faultinjection.test.ts
//
// WHY: issue #757 の 31（fail-open）。棚卸しの F-011・F-012 は **DB の中**の話で、
//      外から依存を止めても測れない（PostgREST を止めても DB の中の例外は起きない）。
//      どちらも「例外は握らず、文ごと失敗する」という**安全側の宣言**なのに、
//      一度も確かめていなかった。
//
//      F-012 は特に強い宣言をしている:
//      **「監査が止まると書き込みも止まる（可用性より証跡を優先）」**。
//      本当にそうなら、監査ログに書けない状況で業務データが増えることはない。
//      逆に握りつぶされていれば、**記録の無い書き込み**が静かに通る。
//
// 測り方: DB の中で実際に壊す。
//   F-012 … `audit_log` に必ず失敗する CHECK を足し、監査対象の表へ書けるかを見る
//   F-011 … 認可述語（`is_facility_member`）を例外を投げる版に差し替え、
//           RLS を通る SELECT が「空が返る」のか「失敗する」のかを見る
//
// 壊したものは必ず戻す。戻し方は 3 重にしてある:
//   1. それぞれの try/finally
//   2. afterAll（テストが落ちても走る）
//   3. **復元用 SQL をファイルに書き出し**、scripts/measure-fail-open.sh の trap が最後に適用する
//      （プロセスごと落ちた場合の最後の砦）
//
// **CI では回さない。** `bash scripts/measure-fail-open.sh` から人が起動する。

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  type SeededUser,
} from '../integration/helpers/seed-rls-idor'

const PROJECT = 'medical-inventory-vkumai'
const DB = `supabase_db_${PROJECT}`
const RESTORE_DIR = path.resolve(__dirname, '../../../.aidd')
const RESTORE_FILE = path.join(RESTORE_DIR, 'fault-injection-restore.sql')

/** docker 経由で psql を直に叩く。shell を通さないので値の引用に悩まない */
function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { encoding: 'utf8', timeout: 60_000 },
  ).trim()
}

/** 壊す前に「戻し方」をファイルへ置く。プロセスごと落ちても wrapper が適用する */
function armRestore(sql: string): void {
  mkdirSync(RESTORE_DIR, { recursive: true })
  writeFileSync(RESTORE_FILE, sql, 'utf8')
}
function disarmRestore(): void {
  if (existsSync(RESTORE_FILE)) rmSync(RESTORE_FILE)
}

const AUDIT_FAIL_CONSTRAINT = 'tmp_fault_injection_always_fails'

describe('DB の中で壊したときにどちら側へ倒れるか（fail-open の実測） [F-011][F-012]', () => {
  const service = createServiceRoleClient()
  let facility: { id: string; name: string }
  let user: SeededUser

  beforeAll(async () => {
    facility = await createFacility(service, `db-fault-${Date.now()}`)
    user = await createSeededUser(service, 'db-fault', facility.id, 'staff')
    // WHY(空振り防止。初回の測定で実際にやらかした): RLS の USING 句は**行ごと**に評価される。
    //      対象の表が 0 行だと述語は一度も呼ばれず、壊しても「0 件」が返って
    //      「例外にならなかった」と読めてしまう。**評価させるために 1 行入れる**
    const { error } = await service
      .from('consumables')
      .insert({ facility_id: facility.id, name: 'fault-injection-probe', purpose: '測定用' })
    if (error) throw new Error(`consumables の種まき失敗: ${error.message}`)
  }, 120_000)

  afterAll(async () => {
    // **何があっても戻す**
    try {
      psql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS ${AUDIT_FAIL_CONSTRAINT}`)
    } catch { /* 既に落ちている */ }
    disarmRestore()
    if (user) await service.auth.admin.deleteUser(user.id)
    if (facility) await service.from('facilities').delete().eq('id', facility.id)
  }, 120_000)

  it('平常時: 監査対象の表に書くと監査行が 1 行増える（基準）', async () => {
    const name = `audit-baseline-${Date.now()}`
    const { data, error } = await service.from('facilities').insert({ name }).select('id').single()
    expect(error).toBeNull()
    const rows = psql(
      `SELECT count(*) FROM audit_log WHERE table_name = 'facilities' AND row_id = '${data!.id}'`,
    )
    expect(Number(rows)).toBe(1)
    await service.from('facilities').delete().eq('id', data!.id)
  })

  // WHY: F-012 の宣言「監査が止まると書き込みも止まる」を、実際に監査を止めて確かめる。
  //      握りつぶされていれば **記録の残らない書き込み**が通ってしまう
  it('F-012: 監査ログに書けないとき、業務データの書き込みごと失敗する', async () => {
    armRestore(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS ${AUDIT_FAIL_CONSTRAINT};`)
    // NOT VALID にするのは既存行を検査させないため。**新しい INSERT には効く**
    psql(`ALTER TABLE audit_log ADD CONSTRAINT ${AUDIT_FAIL_CONSTRAINT} CHECK (false) NOT VALID`)
    const name = `audit-blocked-${Date.now()}`
    try {
      const { error } = await service.from('facilities').insert({ name })
      console.log(`  監査が書けないときの INSERT: ${error ? `失敗 ${error.code} ${error.message}` : '**通った**'}`)
      expect(error, '監査が書けないのに業務データが通った（記録の無い書き込みができる）').not.toBeNull()

      // **行が残っていないこと**まで見る。エラーが返っても行が作られていたら意味がない
      const left = psql(`SELECT count(*) FROM facilities WHERE name = '${name}'`)
      console.log(`  そのとき残った facilities の行: ${left}`)
      expect(Number(left), '書き込みが失敗したのに行が残っている（ロールバックしていない）').toBe(0)
    } finally {
      psql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS ${AUDIT_FAIL_CONSTRAINT}`)
      disarmRestore()
    }
  })

  it('F-012: 監査を戻すと、また書けるようになる（測定が環境を壊していない）', async () => {
    const name = `audit-restored-${Date.now()}`
    const { data, error } = await service.from('facilities').insert({ name }).select('id').single()
    expect(error).toBeNull()
    await service.from('facilities').delete().eq('id', data!.id)
  })

  // WHY: F-011 の宣言「SQL 関数の例外は文ごと失敗する」を確かめる。
  //      ただし `consumables` には **permissive なポリシーが 2 つ**あり OR で合成される:
  //        facility_member_or_admin … (is_facility_member OR is_admin) AND has_aal2
  //        facility_writer_or_admin … (is_facility_writer OR is_admin) AND has_aal2
  //      staff は writer なので、片方を壊しても**もう片方が先に通し、壊れた述語は呼ばれない**。
  //      「壊れたら必ず落ちる」ではないので、書き手（別の道がある）と viewer（この道しかない）の
  //      両方を測って書き分ける
  it('F-011: 認可述語を壊したとき、別の permissive ポリシーがあると呼ばれずに通る', async () => {
    const original = psql(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_facility_member'`,
    )
    expect(original, '元の定義を取れていない（戻せないので壊さない）').toContain('is_facility_member')
    armRestore(original + '\n')

    // 壊す前に「述語が呼ばれる状態か」を確かめる（0 件なら壊しても何も起きない）
    const before = await user.client.from('consumables').select('id')
    expect(before.error).toBeNull()
    expect((before.data ?? []).length, '対象の行が 0 件では述語が評価されない（空振り）').toBeGreaterThan(0)

    const viewer = await createSeededUser(service, 'db-fault-viewer', facility.id, 'viewer')
    try {
      psql(`CREATE OR REPLACE FUNCTION is_facility_member(p_facility_id uuid)
            RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
            AS $fn$ BEGIN RAISE EXCEPTION 'fault injection: predicate is broken'; END; $fn$`)

      // (1) staff（書き手）: writer 側のポリシーが通すので、壊れた述語は評価されない
      const asStaff = await user.client.from('consumables').select('id').limit(1)
      console.log(
        `  staff（別の道あり）: ${asStaff.error ? `失敗 ${asStaff.error.code}` : `**${(asStaff.data ?? []).length} 件返った**`}`,
      )

      // (2) viewer（読むだけ）: この述語しか道が無いので、壊れれば文ごと失敗するはず
      const asViewer = await viewer.client.from('consumables').select('id').limit(1)
      console.log(
        `  viewer（この道だけ）: ${asViewer.error ? `失敗 ${asViewer.error.code} ${asViewer.error.message}` : `**${(asViewer.data ?? []).length} 件返った**`}`,
      )

      expect(asStaff.error, 'staff で落ちた（別の道が無かった？ポリシー構成が変わっている）').toBeNull()
      expect(asViewer.error, '**唯一の述語が壊れているのに viewer の SELECT が成功した**').not.toBeNull()
      // 「0 件」ではなく「失敗」であること。空だと壊れていることに気づけない
      expect((asViewer.data ?? []).length).toBe(0)
    } finally {
      psql(original)
      disarmRestore()
      await service.auth.admin.deleteUser(viewer.id)
    }
  }, 120_000)

  it('F-011: 述語を戻すと、また読めるようになる（測定が環境を壊していない）', async () => {
    const { error } = await user.client.from('consumables').select('id').limit(1)
    expect(error, '復元後も読めないまま（環境が壊れている）').toBeNull()
  })

  // WHY: F-011 のもう半分。棚卸しには「`has_aal2` は JWT に `aal` が無ければ false」と書いてある。
  //      **実測するとそうではない**: TOTP を登録していない利用者には `aal` を見ずに true を返す
  //      （MFA 未登録の運用を壊さないための設計。20260806000001）。
  //      安全上ほんとうに効いてほしいのは**登録済みの利用者から `aal` を剥いだとき**なので、
  //      両方を測って書き分ける
  it('F-011: has_aal2 は「TOTP 登録済みの利用者から aal を剥いだとき」に false になる', async () => {
    const claims = (sub: string, extra = '') =>
      `{"sub":"${sub}"${extra}}`
    const call = (json: string) =>
      psql(`SELECT set_config('request.jwt.claims', '${json}', true) IS NOT NULL AND has_aal2()`)

    // (1) MFA 未登録の利用者: aal が無くても true（棚卸しの記述と違う。設計どおり）
    const notEnrolled = call(claims(user.id))
    // (2) MFA 登録済みの利用者から aal を剥ぐ: false でなければならない
    const enrolledUser = await createSeededUser(service, 'db-fault-mfa', facility.id, 'staff')
    try {
      psql(`INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
            VALUES (gen_random_uuid(), '${enrolledUser.id}', 'probe', 'totp', 'verified', now(), now())`)
      const enrolledNoAal = call(claims(enrolledUser.id))
      const enrolledAal1 = call(claims(enrolledUser.id, ',"aal":"aal1"'))
      const enrolledAal2 = call(claims(enrolledUser.id, ',"aal":"aal2"'))
      console.log(
        `  未登録(aal なし)=${notEnrolled} / 登録済み(aal なし)=${enrolledNoAal}` +
          ` / 登録済み(aal1)=${enrolledAal1} / 登録済み(aal2)=${enrolledAal2}`,
      )

      expect(notEnrolled, 'MFA 未登録では aal を見ずに true（設計）').toBe('t')
      expect(enrolledNoAal, '**登録済みなのに aal を剥いだら通った**').toBe('f')
      expect(enrolledAal1, '登録済みの aal1 が通った').toBe('f')
      expect(enrolledAal2, '登録済みの aal2 が通らない').toBe('t')
    } finally {
      psql(`DELETE FROM auth.mfa_factors WHERE user_id = '${enrolledUser.id}'`)
      await service.auth.admin.deleteUser(enrolledUser.id)
    }
  }, 120_000)
})
