// WHY: 2026-09-07。新しい表を作るときに決めることは 4 つある。
//        (1) RLS を有効にするか  (2) ポリシーを作るか
//        (3) **誰が読み書きできるか**  (4) 監査対象にするか
//      ところが検査は (1)(2) が rls_enabled_all_tables、(4) が audit_trigger_coverage と
//      別々にあり、**(3) を見る検査は 1 つも無かった**。しかも「意図的にポリシーを作らない表」
//      「監査対象から外す表」の許可リストが別ファイルに 2 つあり、同じ判断が二重に書かれていた。
//
//      その結果 `schema_drift_log` は作られてから 2 か月間、GRANT が 1 行も無く
//      **service_role でも読めなかった**。夜間の不変条件検査を守るテストは「記録されたか」を
//      読めないまま赤で放置され、誰も直しに来なかった。
//
//      検知を賢くするのではなく、**決め忘れられる道を無くす**。宣言はこの 1 枚だけ。
//      新しい表を作ると table_registry.test.ts が「宣言が無い」で落ちる。
//      宣言と実態がずれても落ちる（どちらの向きも）。
//
//      ここはデータだけを置く（テストから import される）。検査は
//      supabase/migrations/__tests__/table_registry.test.ts にある。

import type { ClientRole } from './table-facts'

/** 'あり' か、そうしない理由（理由は 20 文字より長いこと） */
export type Decision = 'あり' | string

export interface TableDecl {
  /** SELECT を持つ client ロール（postgres は所有者なので対象外） */
  reads: ClientRole[]
  /** INSERT / UPDATE / DELETE / TRUNCATE のどれかを持つ client ロール */
  writes: ClientRole[]
  policies: Decision
  audit: Decision
}

/** 業務データの既定形: RLS のポリシーで守り、authenticated と service_role が読み書きする */
const APP_TABLE: TableDecl = {
  reads: ['authenticated', 'service_role'],
  writes: ['authenticated', 'service_role'],
  policies: 'あり',
  audit: 'あり',
}

export const TABLE_REGISTRY: Record<string, TableDecl> = {
  // --- マスタ ---
  products: APP_TABLE,
  facilities: APP_TABLE,
  distributor_products: APP_TABLE,
  categories: APP_TABLE,
  product_compatibilities: APP_TABLE,

  // --- 施設スコープの業務データ ---
  hospital_prices: APP_TABLE,
  consumables: APP_TABLE,
  case_orders: APP_TABLE,
  case_order_items: APP_TABLE,
  consumable_orders: APP_TABLE,
  consumable_order_items: APP_TABLE,
  loan_orders: APP_TABLE,
  loan_order_items: APP_TABLE,
  loan_returns: APP_TABLE,
  loan_return_items: APP_TABLE,

  // --- 所属（権限） ---
  user_facilities: {
    reads: ['authenticated', 'service_role'],
    // 権限の付け外しは管理 API（service_role）だけが行う。利用者が自分の役割を書き換えられては困る
    writes: ['service_role'],
    policies: 'あり',
    audit: 'あり',
  },

  // --- 追記のみの記録 ---
  price_histories: {
    reads: ['authenticated', 'service_role'],
    // トリガーが書くので、誰にも直接の書き込み権限を与えない
    writes: [],
    policies: 'あり',
    audit:
      '価格の履歴そのもの。append-only で「誰がいつ何を」を既に持っており、監査行を足すと同じ事実が二重に残る',
  },
  audit_log: {
    reads: ['authenticated', 'service_role'],
    // 監査ログは消せない・書き換えられないことが価値。書き込みは SECURITY DEFINER のトリガーだけ
    writes: [],
    policies: 'あり',
    audit:
      '監査ログ自身。自分への INSERT でまた自分に書くと無限に増える（append-only トリガーで UPDATE / DELETE は別途拒否している）',
  },

  // --- 監視の裏方（ポリシーを作らない = SECURITY DEFINER 関数からしか触らない） ---
  schema_drift_log: {
    // 2026-09-07 まで GRANT が 1 行も無く、service_role でも読めなかった（20260907010000 で是正）
    reads: ['service_role'],
    writes: [],
    policies:
      'スキーマドリフト検知の内部テーブル。record_schema_drift() 等の SECURITY DEFINER 関数からのみ書き込み、クライアントロールへ直接は公開しない',
    audit: '監視そのものの記録であって、業務上の変更ではない。ここが動くのは検知が走ったときだけ',
  },
  schema_baseline_snapshots: {
    reads: ['service_role'],
    writes: [],
    policies:
      'スキーマドリフト検知の内部テーブル。refresh_schema_baseline_snapshot() からのみ書き込み、クライアントロールへ直接は公開しない',
    audit:
      '同じく監視の裏方であって業務上の変更ではない。ここが変わるのはスキーマそのものを直したときだけ',
  },
}

/** 意図的にポリシーを作らない表（rls_enabled_all_tables.test.ts の許可リストの正本） */
export const INTENTIONALLY_POLICYLESS_TABLES: ReadonlySet<string> = new Set(
  Object.entries(TABLE_REGISTRY)
    .filter(([, decl]) => decl.policies !== 'あり')
    .map(([name]) => name),
)

/** 意図的に監査対象から外す表 → その理由（audit_trigger_coverage.test.ts の正本） */
export const AUDIT_EXEMPT_TABLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TABLE_REGISTRY)
    .filter(([, decl]) => decl.audit !== 'あり')
    .map(([name, decl]) => [name, decl.audit]),
)
