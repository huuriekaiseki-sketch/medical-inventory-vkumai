# ドメイン用語集

このリポジトリで使われるドメイン用語の定義。読者はAIエージェント（実装担当）なので、
「それが何であるか」に加えて、実装上どのテーブル・関数に対応するかも書く（純粋な用語集には
しない）。ただし関数のロジック詳細やAPIのハウツーまでは書かない — それはコードを読めばわかる。
用語の由来は主に `supabase/migrations/` のテーブル定義。

## テナント・施設

**facility（施設）**:
マルチテナントの単位。病院・クリニックなど、在庫・発注を管理する組織の単位。
`facilities` テーブルが実体。

**user_facilities**:
ユーザーと施設の所属関係を表す中間テーブル。1ユーザーが複数施設に所属できる。
`role`列（例: `admin`）も持ち、施設内でのユーザー権限を表す。

**is_facility_member(facility_id)**:
「呼び出しユーザーがこの施設のメンバーか」を判定するDB関数（SECURITY DEFINER）。
RLSポリシーの中核であり、施設をまたいだデータ越境を防ぐ唯一のゲート。

## マスタ・価格

**distributor_product（卸売商品）**:
施設に依存しない共通マスタ。どの施設からも参照される。
_Avoid_: 商品、product単体（hospital_priceとの対比で使う場合はdistributor_productと明示する）

**hospital_price（施設別価格）**:
`distributor_product` × `facility` の組み合わせに対する、その施設固有の仕入価格。
`hospital_prices` テーブルが実体（`unique(distributor_product_id, facility_id)`）。

**price_histories（価格変更履歴）**:
`hospital_price` と `distributor_product` 両方の価格変更を記録するポリモーフィックテーブル。
`entity_type` カラムで対象種別を区別する。

## 発注・在庫の種類

**consumable（消耗品）**:
施設固有の消耗品カタログ。`consumables` テーブルが実体。

**case_order（症例発注）**:
手術・処置（症例）に紐づく発注。患者情報・術式・担当医を持つ。

**consumable_order（消耗品発注）**:
消耗品カタログ（`consumables`）に対する発注。

**loan_order（短貸発注）**:
医療機器・器材の短期貸出（短貸）の発注。

**loan_return（短貸返却）**:
`loan_order` で借りたものの返却記録。

すべての発注系テーブル（`case_orders` / `consumable_orders` / `loan_orders` / `loan_returns`）は
`facility_id` を持ち、`is_facility_member` によるRLSで施設外からのアクセスを遮断する。

**lot（ロット番号）**:
医療機器・消耗品の製造ロット番号。`case_order_items.lot` / `loan_return_items.lot` に記録。
リコール発生時のトレーサビリティ目的で発注・返却明細に個体単位で記録する自由入力フィールド。
在庫テーブル自体をロット単位で区分する在庫管理（ロット別在庫追跡）は現状未実装。

**ubd（使用期限）**:
"Use By Date" の略（医療材料業界の一般的な略語）。`case_order_items.ubd` / `loan_return_items.ubd`
に記録。`lot` 同様、発注・返却明細の付帯情報として記録されるのみで、期限切れアラート等の機能は
現状未実装。

**jan（JANコード）**:
商品バーコード。`case_order_items.jan` / `loan_order_items.jan` / `loan_return_items.jan` /
`consumables.jan` に記録。`distributor_product` との突合キーとしては現状使われていない
（発注明細の自由入力フィールド）。

## 未実装のドメイン概念（2026-07時点）

医療材料業界で一般的だが、本リポジトリのスキーマには対応するテーブル・カラムが存在しない用語。
実装済みと誤認して設計・レビューしないよう明記する。

- **預託在庫**: 卸業者が施設内に置く在庫（所有権は卸業者のまま）。対応テーブルなし。
- **棚卸**: 実地在庫数と台帳の突合作業。対応テーブル・機能なし。
