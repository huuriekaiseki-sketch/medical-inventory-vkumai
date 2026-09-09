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
//   - pathId: [id] に入れる値。**フィクスチャが実際に作った行**を指す名前か 'random'
//   - skip: 攻撃の対象外（理由必須。OAuth コールバック等）
//   - weak: 認可の判定に**到達しない**ことが分かっている印。備考に理由を書く
//
// **weak は宣言だけでなく実測と突き合わせる**（2026-09-09）。spec が毎回、実際の応答から
// 「入口の検証で 400 になった」「実在しない ID で 404 になった」を判定し、
//   - weak と書いてあるのに実は到達していた → 陳腐化として落とす
//   - weak と書いていないのに到達していなかった → 見かけだけの攻撃として落とす
// つまり **weak を消すには本当に到達させるしかない**。逃げ道として印だけ足すこともできない。

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** [id] に入れる値の名前。'random' 以外はフィクスチャが実際に作った行を指す */
export type PathId =
  | 'facilityA'
  | 'loanOrderA'
  | 'distributorProductA'
  | 'hospitalPriceA'
  | 'productA'
  | 'categoryA'
  | 'compatA'
  | 'random'

export interface AttackCase {
  query?: Record<string, string>
  body?: unknown
  pathId?: PathId
  weak?: boolean
  note?: string
}

export type RouteAttacks = Partial<Record<Method, AttackCase | { skip: string }>>

// プレースホルダは spec 側で fixtures の実値に置き換える
export const FACILITY_A = '__FACILITY_A__'
export const LOAN_ORDER_A = '__LOAN_ORDER_A__'
export const PRODUCT_A = '__PRODUCT_A__'
export const SECOND_PRODUCT_A = '__SECOND_PRODUCT_A__'
export const CATEGORY_A = '__CATEGORY_A__'
export const DISTRIBUTOR_PRODUCT_A = '__DISTRIBUTOR_PRODUCT_A__'
export const RANDOM_UUID = '__RANDOM_UUID__'

const ISO = '2026-09-06T00:00:00.000Z'

export const ATTACK_MATRIX: Record<string, RouteAttacks> = {
  '/auth/callback': { GET: { skip: 'OAuth コールバック。code 無しでは Supabase へ行かずリダイレクトするだけで施設データに触れない' } },

  // 施設スコープ（発注・返却・消耗品・仕入価格）
  '/api/loan-orders/[id]': {
    PATCH: { pathId: 'loanOrderA', body: { facilityId: FACILITY_A, action: 'cancel' }, note: '施設 A の**実在する**短貸発注を他施設の利用者が取り消せないこと（E-056）' },
  },
  '/api/loan-orders': {
    POST: { body: { facilityId: FACILITY_A, procedureName: '攻撃テスト用術式', maker: '攻撃テスト用メーカー', items: [] } },
  },
  '/api/case-orders/[id]': {
    PATCH: { pathId: 'random', body: { facilityId: FACILITY_A, action: 'cancel' }, note: '施設 A の発注を勝手に取り消せない（E-056）。id は存在しない UUID で、認可が先に 403 を返すこと' },
  },
  '/api/case-orders': {
    POST: { body: { facilityId: FACILITY_A, caseDatetime: ISO, procedureName: '攻撃テスト用術式', patientId: 'ATTACK-0000', patientInitials: 'ZZ', gender: 'other', doctorName: '攻撃テスト用医師', items: [] } },
  },
  '/api/consumable-orders/[id]': {
    PATCH: { pathId: 'random', body: { facilityId: FACILITY_A, action: 'cancel' }, note: '施設 A の発注を勝手に取り消せない（E-056）。id は存在しない UUID で、認可が先に 403 を返すこと' },
  },
  '/api/consumable-orders': {
    POST: { body: { facilityId: FACILITY_A, items: [{ consumableId: RANDOM_UUID, quantity: 1 }] }, note: 'consumableId は存在しない UUID。認可が先に 403 を返すこと' },
  },
  '/api/loan-returns': {
    POST: { body: { facilityId: FACILITY_A, returnDatetime: ISO, loanOrderId: LOAN_ORDER_A, items: [] }, note: '施設 A の実在する短貸発注に対する返却の詐称' },
  },
  '/api/loan-returns/[id]': {
    PATCH: { pathId: 'random', body: { facilityId: FACILITY_A, action: 'cancel' }, note: '施設 A の返却を勝手に取り消せない（E-056）。id は存在しない UUID で、認可が先に 403 を返すこと' },
  },
  '/api/consumables': {
    POST: { body: { facilityId: FACILITY_A, name: '攻撃テスト用消耗品', purpose: '攻撃テスト' } },
  },
  '/api/hospital-prices': {
    POST: { body: { facilityId: FACILITY_A, distributorProductId: DISTRIBUTOR_PRODUCT_A, purchasePrice: 1, deliveryPrice: 1 } },
  },
  // WHY(2026-09-09 に weak をやめた): 施設 A の院内価格をフィクスチャに作ったので、
  //      実在する行に対して「読めず・変えられず・消せない」を実際に測る（資産 A-02）。
  //      GET / PUT / DELETE が 404 を返すのは RLS が 0 行にするからで、
  //      「存在しない ID だから 404」とは別物（hospital-prices.spec.ts が対で測っている）
  '/api/hospital-prices/[id]': {
    GET: { pathId: 'hospitalPriceA' },
    PUT: { pathId: 'hospitalPriceA', body: { facilityId: FACILITY_A, distributorProductId: DISTRIBUTOR_PRODUCT_A, purchasePrice: 1, deliveryPrice: 1 } },
    DELETE: { pathId: 'hospitalPriceA' },
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
    // DELETE は 2026-09-08 に消した（E-055）。`facilities` に DELETE の RLS ポリシーが無く、
    // admin が叩いても 0 行になって実在する施設に 404 を返す「使えない道」だった。
  },
  '/api/facilities/[id]/my-role': {
    GET: { pathId: 'facilityA', note: '未所属なら role null。施設 A の存在は施設マスタとして非分離' },
  },

  // 商品マスタ（参照は非分離、書き込みは admin のみ）。
  // WHY(2026-09-09 に weak をやめた): body に `ref` が無く入口の検証で 400 になっていたため、
  //      **admin 境界に一度も到達していなかった**。実在する行と通る body に変えて、
  //      施設 B の staff が「読めるが変えられない」ことを実際に測る（P-021 / P-033）
  '/api/products': {
    POST: { body: { jan: '0000000000000', ref: '攻撃テスト用品番', name: '攻撃テスト用商品', maker: '攻撃テスト' } },
  },
  '/api/products/[id]': {
    GET: { pathId: 'productA', note: 'マスタの参照は非分離。施設 A の目印が混ざっていないことだけを見る' },
    PUT: { pathId: 'productA', body: { jan: '0000000000001', ref: '攻撃テストで改番', name: '攻撃テストで改名', maker: '攻撃テスト' } },
    DELETE: { pathId: 'productA' },
  },
  '/api/categories': { POST: { body: { name: '攻撃テスト用カテゴリ' } } },
  '/api/categories/[id]': {
    GET: { pathId: 'categoryA' },
    PUT: { pathId: 'categoryA', body: { name: '攻撃テストで改名' } },
    DELETE: { pathId: 'categoryA' },
  },
  '/api/distributor-products': {
    POST: { body: { productId: PRODUCT_A, categoryId: CATEGORY_A, maker: '攻撃テスト', supplier: '攻撃テスト卸', name: '攻撃テスト用代理店商品', quantity: 1 } },
  },
  '/api/distributor-products/[id]': {
    GET: { pathId: 'distributorProductA' },
    PUT: { pathId: 'distributorProductA', body: { productId: PRODUCT_A, categoryId: CATEGORY_A, maker: '攻撃テストで改名', supplier: '攻撃テスト卸', name: '攻撃テストで改名', quantity: 1 } },
    DELETE: { pathId: 'distributorProductA' },
  },
  '/api/distributor-products/[id]/price-history': {
    GET: { pathId: 'distributorProductA', query: { facilityId: FACILITY_A, facility_id: FACILITY_A }, note: '2026-09-09 に weak をやめた。施設 A の院内価格と改定履歴をフィクスチャに作ったので、施設 B の利用者が叩いても施設 A の仕切値・施設名が出ないことを実際に測る（資産 A-02）' },
  },
  '/api/compat': {
    POST: { body: { categoryId: CATEGORY_A, productId1: PRODUCT_A, productId2: SECOND_PRODUCT_A }, note: '実在する製品 2 件の互換ペア。staff は登録できない' },
  },
  '/api/compat/[id]': { DELETE: { pathId: 'compatA', note: '実在する互換ペアを staff が消せないこと' } },
  '/api/compat/products': {
    GET: { query: { categoryId: CATEGORY_A, facilityId: FACILITY_A, facility_id: FACILITY_A }, note: 'categoryId が無いと入口で 400 になり認可まで届かない。実在するカテゴリを渡す' },
  },

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
  // WHY: 監査ログの閲覧（issue #757 の 4・24）。他施設の ID を指定しても、admin でない
  //      利用者には 403 が返り、施設 A の記録が 1 行も見えないことを確かめる
  '/api/admin/audit': {
    GET: { query: { kind: 'changes', facility_id: FACILITY_A }, note: '他施設の監査ログを覗けない' },
  },
}
