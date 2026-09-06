// e2e/api-attack-matrix.ts
// WHY: 約束カタログ P-017（issue #757 の 1）。API Route を「他施設のユーザーが、施設 A の ID を
//      query / body / path のどこに入れても、施設 A のデータを読めず・変えられない」という不変条件で
//      総当たりする（api-cross-facility-attack.spec.ts）。route ごとの期待ステータスを手書きしない
//      代わりに、書き込み系メソッドだけは「バリデーションを通過して認可判定まで到達する body」が
//      要るので、ここに置く。表に無い route × メソッドが増えると spec が失敗する（ratchet）。
//
// 表の読み方:
//   - キーは route パス（src/app/api/<...>/route.ts → '/api/<...>'。動的部分は [id] のまま）
//   - 値はメソッドごとの AttackCase。GET は省略可（既定: query に facility_id / facilityId = 施設 A）
//   - pathId: [id] に入れる値。'facilityA' | 'loanOrderA' | 'random'（施設 A の資源が無ければ random。
//     random は 404 になるだけで境界の検査としては弱い。備考に理由を書く）
//   - skip: 攻撃の対象外（理由必須。OAuth コールバック等）
//   - weak: true = バリデーションが認可より先に走るため 400 で止まる等、境界判定まで到達しない
//     ことが分かっている（不変条件の検査自体は行う）。備考に理由を書く

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface AttackCase {
  query?: Record<string, string>
  body?: unknown
  pathId?: 'facilityA' | 'loanOrderA' | 'random'
  weak?: boolean
  note?: string
}

export type RouteAttacks = Partial<Record<Method, AttackCase | { skip: string }>>

// プレースホルダは spec 側で fixtures の実値に置き換える
export const FACILITY_A = '__FACILITY_A__'
export const LOAN_ORDER_A = '__LOAN_ORDER_A__'
export const RANDOM_UUID = '__RANDOM_UUID__'

const ISO = '2026-09-06T00:00:00.000Z'

export const ATTACK_MATRIX: Record<string, RouteAttacks> = {
  '/auth/callback': { GET: { skip: 'OAuth コールバック。code 無しでは Supabase へ行かずリダイレクトするだけで施設データに触れない' } },

  // 施設スコープ（発注・返却・消耗品・仕入価格）
  '/api/loan-orders': {
    POST: { body: { facilityId: FACILITY_A, procedureName: '攻撃テスト用術式', maker: '攻撃テスト用メーカー', items: [] } },
  },
  '/api/case-orders': {
    POST: { body: { facilityId: FACILITY_A, caseDatetime: ISO, procedureName: '攻撃テスト用術式', patientId: 'ATTACK-0000', patientInitials: 'ZZ', gender: 'other', doctorName: '攻撃テスト用医師', items: [] } },
  },
  '/api/consumable-orders': {
    POST: { body: { facilityId: FACILITY_A, items: [{ consumableId: RANDOM_UUID, quantity: 1 }] }, note: 'consumableId は存在しない UUID。認可が先に 403 を返すこと' },
  },
  '/api/loan-returns': {
    POST: { body: { facilityId: FACILITY_A, returnDatetime: ISO, loanOrderId: LOAN_ORDER_A, items: [] }, note: '施設 A の実在する短貸発注に対する返却の詐称' },
  },
  '/api/consumables': {
    POST: { body: { facilityId: FACILITY_A, name: '攻撃テスト用消耗品', purpose: '攻撃テスト' } },
  },
  '/api/hospital-prices': {
    POST: { body: { facilityId: FACILITY_A, distributorProductId: RANDOM_UUID, purchasePrice: 1, deliveryPrice: 1 } },
  },
  '/api/hospital-prices/[id]': {
    GET: { pathId: 'random', weak: true, note: '施設 A の仕入価格をシードしていないため 404 止まり。シード追加で強化できる' },
    PUT: { pathId: 'random', body: { facilityId: FACILITY_A, distributorProductId: RANDOM_UUID, purchasePrice: 1, deliveryPrice: 1 }, weak: true, note: '同上' },
    DELETE: { pathId: 'random', weak: true, note: '同上' },
  },
  '/api/orders': {},
  '/api/dashboard': { GET: { note: 'クライアント入力を持たない。自施設のみ集計されることを応答の目印で確認' } },
  '/api/news': {},

  // 施設マスタ（参照は非分離、書き込みは admin のみ）
  '/api/facilities': {
    POST: { body: { name: '攻撃テスト用施設' }, note: 'staff は作成不可（P-021）' },
  },
  '/api/facilities/[id]': {
    GET: { pathId: 'facilityA', note: '2026-09-06 実測: facilities の RLS により未所属の施設は 404（P-021 の「参照は非分離」はマスタ一覧の話で、行単位では所属施設のみ）' },
    PUT: { pathId: 'facilityA', body: { name: '攻撃テストで改名' } },
    DELETE: { pathId: 'facilityA' },
  },
  '/api/facilities/[id]/my-role': {
    GET: { pathId: 'facilityA', note: '未所属なら role null。施設 A の存在は施設マスタとして非分離' },
  },

  // 商品マスタ（参照は非分離、書き込みは admin のみ）
  '/api/products': { POST: { body: { jan: '0000000000000', name: '攻撃テスト用商品', maker: '攻撃テスト' }, weak: true, note: 'admin 境界は P-021 の統合テストが正本。ここでは施設 A の目印が無いことのみ' } },
  '/api/products/[id]': {
    GET: { pathId: 'random', weak: true },
    PUT: { pathId: 'random', body: { jan: '0000000000000', name: '攻撃テスト用商品', maker: '攻撃テスト' }, weak: true },
    DELETE: { pathId: 'random', weak: true },
  },
  '/api/categories': { POST: { body: { name: '攻撃テスト用カテゴリ' }, weak: true } },
  '/api/categories/[id]': {
    GET: { pathId: 'random', weak: true },
    PUT: { pathId: 'random', body: { name: '攻撃テスト用カテゴリ' }, weak: true },
    DELETE: { pathId: 'random', weak: true },
  },
  '/api/distributor-products': { POST: { body: { name: '攻撃テスト用代理店商品', productJan: '0000000000000' }, weak: true } },
  '/api/distributor-products/[id]': {
    GET: { pathId: 'random', weak: true },
    PUT: { pathId: 'random', body: { name: '攻撃テスト用代理店商品' }, weak: true },
    DELETE: { pathId: 'random', weak: true },
  },
  '/api/distributor-products/[id]/price-history': {
    GET: { pathId: 'random', query: { facilityId: FACILITY_A, facility_id: FACILITY_A }, weak: true, note: '施設 A の価格履歴をシードしていない' },
  },
  '/api/compat': { POST: { body: { productJan: '0000000000000', compatibleJan: '0000000000001' }, weak: true } },
  '/api/compat/[id]': { DELETE: { pathId: 'random', weak: true } },
  '/api/compat/products': {},

  // admin 専用（2026-09-06 実測: proxy.ts の admin ガードが非 admin を /login へリダイレクトするため、
  // route 自身の 403 には到達しない。spec はリダイレクト先を記録し、2xx でも admin データが無いことを検査）
  '/api/admin/users': {
    POST: { body: { email: 'attack-test@example.test' }, note: 'staff は 403（招待メールを送らせない）' },
    DELETE: { body: { userId: RANDOM_UUID }, query: { userId: RANDOM_UUID } },
  },
  '/api/admin/user-facilities': {
    POST: { body: { userId: RANDOM_UUID, facilityId: FACILITY_A, role: 'staff' }, note: '施設 A への所属を勝手に足せない' },
    DELETE: { body: { userId: RANDOM_UUID, facilityId: FACILITY_A }, query: { userId: RANDOM_UUID, facilityId: FACILITY_A } },
  },
  '/api/admin/reports': { GET: { query: { facilityId: FACILITY_A, facility_id: FACILITY_A } } },
}
