// supabase/__tests__/integration/rpc-reference-boundary.integration.test.ts
//
// WHY(混乱した代理人 / confused deputy、2026-09-09): これは「**部外者が RPC を呼べるか**」ではない。
//      それは `rpc-boundary-sweep`（P-019）が見ている。ここが見るのは
//      **正規の利用者が、正規の RPC に、他施設の ID を渡す**形。
//      呼び出し元は正しく認証・認可されていて（施設 A の writer）、
//      渡された**参照先だけ**が他人のもの。RPC がその ID を信用すると越境する。
//
//      `SECURITY DEFINER` の RPC は RLS を通らないので、
//      **RLS がやっていたはずの「この行はあなたのものか」を関数が自分で書く**必要がある。
//      書き直しは関数ごとの手書きで、揃っているかを誰も数えていなかった。実際 2 件出た:
//
//        - `create_consumable_order_atomic`: 明細の消耗品を一切見ていなかった（I-035、20260909060000）
//        - `create_loan_return_atomic`: 明細は見ていたが **header の発注 ID は見ていなかった**
//          （明細を紐付けなければ検証が 1 行も走らない。I-036、20260909070000）
//
// WHY(既存の掃きでは取れない): `rpc-boundary-sweep` は全 RPC に `p_items: []` を渡している。
//      呼べるかどうかしか測っておらず、参照先は最初から対象外だった。
//
// WHY(登録簿を手で書く): 参照先の ID は **`p_items` JSONB の中**にあり、関数の署名からは見えない。
//      型から自動抽出する方式にすると「ID 引数 0 件」と出て**堂々と緑になる**（C-040）。
//      入力の構造と、どの ID が施設境界かは人が書く。機械が見るのは
//      **公開 RPC が全部ここに登録されているか**の方（`未検査` にも理由を書かせる）。
//
// 各件で見るのは 2 方向（片方だけだと「常に拒否」の実装でも緑になる。C-021）:
//   1. 施設 A の利用者 ＋ **施設 B の ID** → 必ず拒否される
//   2. 施設 A の利用者 ＋ **施設 A の ID** → 通る（対照）

import { randomUUID } from 'crypto'
import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findExposedRpcWithoutBoundaryTest } from '../../../.claude/workflows/lib/constraint-coverage.js'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

/**
 * クライアントロールが呼べる RPC を migration から列挙する。
 * **`rpc-boundary-sweep` と同じエンジン**を使う（同じ問いの答えを 2 か所に置かない。E-053）。
 */
function exposedRpcNames(): string[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8') }))
  const collect = (dirs: string[]): string => {
    const chunks: string[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts')) chunks.push(readFileSync(full, 'utf-8'))
      }
    }
    dirs.forEach(walk)
    return chunks.join('\n').toLowerCase()
  }
  const result = findExposedRpcWithoutBoundaryTest({
    migrations,
    boundaryTestSource: collect([path.join(REPO_ROOT, 'supabase/__tests__/integration')]),
    appSource: collect([path.join(REPO_ROOT, 'src/lib'), path.join(REPO_ROOT, 'src/app')]),
  }) as { exposed: string[]; unsupported: string[] }
  return result.exposed
}

/** 施設ごとに用意する「参照先になりうる行」 */
interface FacilityRefs {
  facilityId: string
  /** 短貸発注とその明細 */
  loanOrderId: string
  loanOrderItemId: string
  /** 消耗品 */
  consumableId: string
}

interface RefAttack {
  /** どの参照先を他施設のものに差し替えるか（説明用） */
  reference: string
  /** 施設 A の利用者として呼ぶ引数を作る。`refs` の側を他施設にすると越境になる */
  args: (own: FacilityRefs, refs: FacilityRefs) => Record<string, unknown>
  /** 越境が拒否されたと言えるか（SQLSTATE で見る） */
  rejectCodes: string[]
}

/**
 * 参照先を引数に取る RPC の登録簿。
 * **公開 RPC を足したらここに 1 行足す**（ratchet は下の「登録漏れ」テストが見る）。
 */
const REFERENCE_ATTACKS: Record<string, RefAttack[]> = {
  create_consumable_order_atomic: [
    {
      reference: 'p_items[].consumable_id',
      args: (own, refs) => ({
        p_facility_id: own.facilityId,
        p_items: [{ consumable_id: refs.consumableId, quantity: 1 }],
        p_client_request_id: randomUUID(),
      }),
      rejectCodes: ['23514'],
    },
  ],
  create_loan_return_atomic: [
    {
      reference: 'p_header.loan_order_id（明細を紐付けない場合）',
      args: (own, refs) => ({
        p_header: {
          facility_id: own.facilityId,
          return_datetime: new Date().toISOString(),
          loan_order_id: refs.loanOrderId,
          client_request_id: randomUUID(),
        },
        p_items: [{ jan: JAN, lot: null, ubd: null, quantity: 1 }],
      }),
      rejectCodes: ['23503'],
    },
    {
      reference: 'p_items[].loan_order_item_id',
      args: (own, refs) => ({
        p_header: {
          facility_id: own.facilityId,
          return_datetime: new Date().toISOString(),
          client_request_id: randomUUID(),
        },
        p_items: [{ jan: JAN, lot: null, ubd: null, quantity: 1, loan_order_item_id: refs.loanOrderItemId }],
      }),
      rejectCodes: ['23503'],
    },
  ],
}

/**
 * 参照先を引数に取らない公開 RPC。**理由を書いて外す**（黙って対象から消さない）。
 * 施設 ID そのものを受ける RPC は `is_facility_member` / `is_facility_writer` が見ており、
 * それは `rpc-boundary-sweep`（P-019）が別に測っている。
 */
const NO_REFERENCE_ARGS: Record<string, string> = {
  is_facility_member: '受けるのは施設 ID だけ。他施設を渡すと false が返ることは P-019 が測っている',
  is_facility_writer: '受けるのは施設 ID だけ。is_facility_member と同じ形で、判定は P-019 が測っている',
  is_admin: '引数を 1 つも受けない。自分のセッションだけを見るので参照先という概念が無い',
  has_aal2: '引数を 1 つも受けない。自分のセッションの昇格状態だけを返す',
  get_admin_status: '引数を 1 つも受けない。自分が admin かどうかだけを返す',
  get_order_amount_report: '受けるのは日付の範囲だけ。行 ID を受けないので差し替える参照先が無い',
  get_news_feed: '受けるのは施設 ID と件数・オフセットだけ。行 ID を受けない',
  loan_outstanding_count: '受けるのは施設 ID だけ。数える対象はその施設の発注に限られ、行 ID を受けない',
  resolve_jan_unit_price: 'JAN はマスタ（products）の自然キーで施設に属さない。施設 ID は所属判定で見る',
  resolve_denial_anomaly_subject: '受けるのは伏せ字の文字列だけ。施設に属する行を指さない',
  get_distributor_product_price_history:
    '代理店商品 ID はマスタで施設に属さない。返る履歴が施設境界を守ることは P-019 が測っている',
  create_case_order_atomic: '明細は JAN（マスタの自然キー）だけを受け、施設に属する行 ID を受けない',
  create_loan_order_atomic: '明細は JAN と品名だけを受け、施設に属する行 ID を受けない（症例発注と同じ形）',
}

let JAN = ''

// 約束カタログ: P-013 明細は親の施設境界を越えない
describe('RPC に渡す参照先の施設境界（混乱した代理人） [I-035 I-036 P-013]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let ownRefs: FacilityRefs
  let otherRefs: FacilityRefs

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    const { data } = await serviceClient.from('products').select('jan').eq('id', fx.masters.productId).single()
    JAN = data!.jan as string
    ownRefs = await seedRefs(fx.facilityA.id)
    otherRefs = await seedRefs(fx.facilityB.id)
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  /** 施設 1 つぶんの「参照先になりうる行」を service_role で作る（RLS を通さない） */
  async function seedRefs(facilityId: string): Promise<FacilityRefs> {
    const insert = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await serviceClient.from(table).insert(row).select('id').single()
      expect(error, `${table}: ${JSON.stringify(error)}`).toBeNull()
      return data!.id as string
    }
    const loanOrderId = await insert('loan_orders', {
      facility_id: facilityId,
      procedure_name: `参照境界-${randomUUID().slice(0, 8)}`,
      maker: '参照境界メーカー',
      status: 'submitted',
    })
    const loanOrderItemId = await insert('loan_order_items', {
      loan_order_id: loanOrderId,
      jan: JAN,
      name: '参照境界品',
      quantity: 5,
    })
    const consumableId = await insert('consumables', {
      facility_id: facilityId,
      name: `参照境界消耗品-${randomUUID().slice(0, 8)}`,
      jan: JAN,
      purpose: '参照境界テスト用',
    })
    return { facilityId, loanOrderId, loanOrderItemId, consumableId }
  }

  for (const [rpc, attacks] of Object.entries(REFERENCE_ATTACKS)) {
    for (const attack of attacks) {
      it(`${rpc}: ${attack.reference} に他施設の ID を渡すと拒否される`, async () => {
        const res = await fx.userA.client.rpc(rpc, attack.args(ownRefs, otherRefs))
        expect(
          res.error?.code,
          `越境が拒否されなかった（${rpc} / ${attack.reference}）: ${JSON.stringify(res.error)}`
        ).toBeOneOf(attack.rejectCodes)
      })

      it(`${rpc}: ${attack.reference} が自施設なら通る（対照）`, async () => {
        // WHY(C-021 の対): 拒否側だけを測ると「常に拒否」の実装でも緑になる
        const res = await fx.userA.client.rpc(rpc, attack.args(ownRefs, ownRefs))
        expect(res.error, `自施設の参照先で失敗した: ${JSON.stringify(res.error)}`).toBeNull()
      })
    }
  }

  it('公開 RPC がすべて登録されている（登録漏れで黙って対象外にならない）', () => {
    // WHY(ratchet): 新しい RPC を足したとき、ここに書き忘れると**測らないまま緑**になる。
    //      「参照先を受ける」か「受けない理由」のどちらかを必ず書かせる。
    const exposed = exposedRpcNames().slice().sort()
    expect(exposed.length, '公開 RPC を 1 つも取れていない（走査が壊れている）').toBeGreaterThan(0)

    const declared = new Set([...Object.keys(REFERENCE_ATTACKS), ...Object.keys(NO_REFERENCE_ARGS)])
    const missing = exposed.filter((name) => !declared.has(name))
    expect(missing, `登録簿に無い公開 RPC がある: ${missing.join(', ')}`).toEqual([])

    const stale = [...declared].filter((name) => !exposed.includes(name))
    expect(stale, `登録簿にあるが公開されていない RPC がある: ${stale.join(', ')}`).toEqual([])
  })

  it('外した理由がすべて書かれている（「あとで」で済ませない）', () => {
    const tooShort = Object.entries(NO_REFERENCE_ARGS)
      .filter(([, reason]) => reason.trim().length < 15)
      .map(([name]) => name)
    expect(tooShort, `参照先を受けない理由が短すぎる: ${tooShort.join(', ')}`).toEqual([])
  })
})
