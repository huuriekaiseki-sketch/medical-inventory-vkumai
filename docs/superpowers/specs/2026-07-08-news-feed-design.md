# ニュースページの実体化 設計

- Issue: #22
- 日付: 2026-07-08

## 背景

`src/app/news/page.tsx` が「Coming Soon」のプレースホルダのまま残っている。
価格改定・新製品登録などの既存データを自動フィード化し、実際に機能するニュースページにする。

## 方式

案(a) 自動フィード化を採用。新規テーブルは作らず、既存の `price_histories`（価格改定履歴）と
`distributor_products.created_at`（新製品登録）を統合したフィードをDB側で構築する。

案(b)（手動投稿のお知らせ管理）は新規テーブル・管理UI・運用コストが必要になるため見送り。

## フィードに含めるイベント

| event_type | ソース | 公開範囲 |
|---|---|---|
| `distributor_price_change` | `price_histories`（entity_type='distributor_product'） | 全施設公開 |
| `hospital_price_change` | `price_histories`（entity_type='hospital_price'、facility_id一致） | 施設スコープ（自分の所属施設のみ） |
| `new_product` | `distributor_products.created_at` | 全施設公開 |

`products` 単体の新規登録は対象外（`distributor_products` が実質的な代理店品マスタとして
ユーザーに意味のある単位のため）。

## アーキテクチャ

### DB: 新規マイグレーション `supabase/migrations/<timestamp>_add_news_feed_rpc.sql`

`get_news_feed(p_facility_id uuid, p_limit int, p_offset int)` を新設する。
`get_distributor_product_price_history`（`20260622000000_add_price_histories.sql`）と同じ
UNION ALLパターンを踏襲し、3系統のイベントを `occurred_at DESC` でソートして
`LIMIT/OFFSET` で返す。

- `p_facility_id` が NULL の場合、`hospital_price_change` 系イベントは結果から除外する
  （全体公開イベントのみ返す）
- ページネーションをDB側で行う理由: アプリ層で3系統を個別に取得してマージすると、
  「各ソースをN件ずつ取得→マージ→切り詰め」が必要になり、正しいoffset/limitを保証できない

返却カラム:

```
event_type      TEXT   -- 'distributor_price_change' | 'hospital_price_change' | 'new_product'
occurred_at     TIMESTAMPTZ
distributor_product_id UUID
product_name    TEXT
maker           TEXT
supplier        TEXT
field_name      TEXT   -- price_change系のみ。new_productはNULL
old_value       NUMERIC
new_value       NUMERIC
facility_name   TEXT   -- hospital_price_change系のみ。他はNULL
```

**認可（重要・DEFINERなし方針）**: この関数は `SECURITY DEFINER` を**付けない**（PostgreSQL関数は
デフォルトで `SECURITY INVOKER` = 呼び出しユーザーの権限で実行される）。これにより、
`price_histories` の既存RLSポリシー `facility_member_or_admin`
（`supabase/migrations/20260628010001_update_rls_admin.sql` で定義、確認済み・以降のマイグレーションで
上書きなし）が関数内のクエリにもそのまま適用される:

```sql
-- price_histories の既存ポリシー（確認済み・変更不要）
CREATE POLICY "facility_member_or_admin" ON price_histories
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN entity_type = 'hospital_price' THEN
        EXISTS (
          SELECT 1 FROM hospital_prices hp
          WHERE hp.id = price_histories.entity_id
            AND (is_facility_member(hp.facility_id) OR is_admin())
        )
      WHEN entity_type = 'distributor_product' THEN true
      ELSE false
    END
  );
```

`distributor_products` も `authenticated USING (true)`（`20260629000001_fix_master_rls.sql`）で
全施設公開、`facilities` は `is_facility_member(id) OR is_admin()`（`hospital_prices` と同条件）。
これらは関数を通しても素通りせず自動適用されるため、**関数内で `is_facility_member` を手書きで
チェックする必要はない**。認可ロジックがテーブル側のRLSポリシー1箇所に一元化され、
「関数内チェックの書き忘れ」というバグの再発を構造的に防げる（先の`SECURITY DEFINER`版で
発見された穴は、この設計では原理的に発生しない）。

`SECURITY DEFINER` を使う既存の `get_distributor_product_price_history` とは異なる方針を取る:
あちらは `entity_id`（ポリモーフィック列で `hospital_prices` への実FKではない）越しの
JOINを内部で完結させる都合上DEFINERにしていると見られるが、`get_news_feed` は同様のJOINを
RLSが素通しする形で書けるため、あえてDEFINERにする理由がない。

```sql
CREATE OR REPLACE FUNCTION get_news_feed(
  p_facility_id UUID,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (...)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT ... -- distributor_price_change（price_histories.entity_type='distributor_product' → RLSで全施設公開）
  FROM price_histories ph
  JOIN distributor_products dp ON dp.id = ph.distributor_product_id
  JOIN products p ON p.id = dp.product_id
  WHERE ph.entity_type = 'distributor_product'

  UNION ALL

  SELECT ... -- new_product（distributor_products.created_at → RLSで全施設公開）
  FROM distributor_products dp
  JOIN products p ON p.id = dp.product_id

  UNION ALL

  SELECT ... -- hospital_price_change（price_histories RLSが facility_id 条件を自動適用）
  FROM price_histories ph
  JOIN hospital_prices hp ON hp.id = ph.entity_id
  JOIN facilities f ON f.id = hp.facility_id
  JOIN distributor_products dp ON dp.id = ph.distributor_product_id
  JOIN products p ON p.id = dp.product_id
  WHERE ph.entity_type = 'hospital_price'
    AND (p_facility_id IS NULL OR hp.facility_id = p_facility_id)

  ORDER BY occurred_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;
```

`p_facility_id` がNULLの場合: `hospital_price_change` 枝は `facility_id` で絞り込まないが、
RLSにより非adminユーザーには自分の所属施設分しか返らない（RLSが自動的に安全側にフィルタする）。
明示的な認可チェックやエラーを書く必要がない — 権限がなければRLSが黙って0件を返すだけで、
アプリ層のロジックとして扱う必要すらない。

GRANT: `GRANT EXECUTE ON get_news_feed TO authenticated`（`anon` には付与しない。ニュースページは
ログイン必須ページであり、`anon` ロールは `price_histories`/`distributor_products` のRLSポリシーが
`TO authenticated` 限定のため、そもそもanonで呼んでも常に0件になるが、意図を明確にするため
GRANTからも外す）。

呼び出し元APIの `requireFacilityAccess` は、DB側のRLSとは独立した**UXのための早期リターン**
（未所属施設を指定したら早めに403を返す）として引き続き使う。これがなくても
`get_news_feed` はRLSにより安全だが、エラーメッセージを早く返せる分UXが良い。

### API: `GET /api/news`

`src/app/api/news/route.ts` を新設。

- クエリパラメータ: `facilityId`（任意）, `limit`（デフォルト20）, `offset`（デフォルト0）
- `requireAuth` → `requireFacilityAccess(db, user, facilityId)`
  （`src/lib/supabase/require-facility-access.ts` を再利用。非adminが未所属施設を指定した場合403、
  `facilityId` 省略は許可し全体公開イベントのみ返す）
- `src/lib/news/repository.ts` の `listNewsFeed(db, { facilityId, limit, offset })` を呼び、
  RPC `get_news_feed` の結果をキャメルケースの `NewsFeedItem[]` に変換して返す

### 型: `src/types/newsFeedItem.ts`

```ts
export type NewsFeedItem = {
  eventType: 'distributor_price_change' | 'hospital_price_change' | 'new_product'
  occurredAt: string
  distributorProductId: string
  productName: string
  maker: string
  supplier: string
  fieldName: string | null
  oldValue: number | null
  newValue: number | null
  facilityName: string | null
}
```

### UI: `src/app/news/page.tsx`

`src/app/hospital-prices/page.tsx` と同じ構造のクライアントコンポーネントに置き換える。

- `Suspense` でラップし、内側コンポーネントで `useSearchParams` から `facilityId` を読む
  （SSRハイドレーション時の空白画面防止。既存パターンに準拠）
- 初回ロードで `/api/facilities` を取得し、非adminは所属施設の先頭を自動選択して
  `router.replace('/news?facilityId=...')` でURL同期。管理者は「全施設」相当の未選択状態も許可
- 施設セレクタ（`<select>`）: `/hospital-prices` の実装をほぼそのまま踏襲
- タイムライン一覧: `event_type` ごとにバッジ・アイコンで区別
  - `distributor_price_change` / `hospital_price_change`: 「{productName}: {fieldNameの日本語ラベル} {oldValue}円 → {newValue}円」
  - `new_product`: 「新製品登録: {productName}（{maker} / {supplier}）」
  - `hospital_price_change` のみ施設名を併記
  - 日時はJST表示（`toLocaleString('ja-JP')` 相当、既存の日時表示ユーティリティがあれば流用）
- ページネーション: 「もっと見る」ボタンで `offset += limit` して追加取得・末尾に追記
  （既存に汎用ページャーコンポーネントがないため、`consumable-orders` 系リポジトリの
  limit/offsetパターンをUIにそのまま反映する簡易実装）
- 空状態: 「お知らせはありません」
- エラー時: `/hospital-prices` と同様にエラーメッセージ表示

## テスト

- `src/lib/news/repository.ts` の単体テスト: supabaseクライアントをモックし、
  `get_news_feed` RPCへの引数・レスポンス変換を検証
- `src/app/api/news/route.ts` の単体テスト: 認証なし401、未所属施設403、
  facilityId省略時に全体公開イベントのみ返る、正常系のレスポンス形状
- `src/app/news/page.tsx` のコンポーネントテスト: 施設切替でフィードが再取得される、
  「もっと見る」でoffsetが加算される、空状態の表示
- **DB関数のRLS適用テスト**（`supabase/migrations/__tests__` の既存パターンに従う）:
  他施設に所属するユーザーとして `get_news_feed` をAPI層を経由せず**直接RPC呼び出し**し、
  `p_facility_id` に他施設のIDを渡しても `hospital_price_change` 系イベントが0件になる
  （RLSにより黙って除外される。DEFINERなしのため例外ではなく単に結果に含まれないことを検証する）
  ことを確認する。API Route側のモックやスタブでは検出できないため、Next.jsを経由しない
  DB層単独のテストとして書く

## スコープ外

- 手動お知らせ投稿（案b）は本issueでは対象外。将来必要になれば別issueで検討
- `products` テーブル単体の新規登録通知は対象外
- 既読/未読管理、通知（メール・プッシュ）は対象外
