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

**認可（重要）**: この関数は `SECURITY DEFINER` であり、RLSをバイパスする。SECURITY DEFINER関数に
`GRANT EXECUTE TO anon/authenticated` を付けると `/rest/v1/rpc/get_news_feed` として
Next.jsのAPI Routeを経由せず直接呼び出せるため、「関数内の `p_facility_id` 条件」は
単なるフィルタであり認可チェックではない。他施設のユーザー（または未認証者）が
任意の `p_facility_id` を渡して直接RPCを叩けば、`hospital_price_change`（施設スコープの
機微データ）を他施設分も取得できてしまう。

そのため、関数内で以下の認可チェックを**必ず**行う（既存の `get_distributor_product_price_history`
が `is_facility_member(hp.facility_id)` を関数内でチェックしているのと同じ考え方。詳細は
[`docs/agents/decisions.md`](../../agents/decisions.md) の facility RLS ポリシー方針を参照）:

```sql
CREATE OR REPLACE FUNCTION get_news_feed(
  p_facility_id UUID,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (...)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_facility_id IS NOT NULL
     AND NOT (is_facility_member(p_facility_id) OR is_admin()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ... -- distributor_price_change（全施設公開・facility_id条件なし）
  UNION ALL
  SELECT ... -- new_product（全施設公開・facility_id条件なし）
  UNION ALL
  SELECT ...
  FROM price_histories ph
  JOIN hospital_prices hp ON hp.id = ph.entity_id
  JOIN facilities f ON f.id = hp.facility_id
  WHERE ph.entity_type = 'hospital_price'
    AND p_facility_id IS NOT NULL
    AND hp.facility_id = p_facility_id  -- 直前のIF文で認可済みのfacility_idのみ通る
  ORDER BY occurred_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;
```

`p_facility_id` がNULLなら認可チェックをスキップして全体公開イベントのみ返す（未指定は許可された
挙動であり、`hospital_price_change` 枝は `p_facility_id IS NOT NULL` 条件で自動的に除外される）。

GRANT: `anon` には付与しない。ニュースページはログイン必須ページであり、`hospital_price_change`
は機微データのため `GRANT EXECUTE ON get_news_feed TO authenticated, service_role` のみとする
（`get_distributor_product_price_history` がanonにも許可しているのは全施設公開データのみを
返す関数だからであり、同じ判断をそのまま流用しない）。

呼び出し元APIの `requireFacilityAccess` は、上記DB関数側チェックとは独立した**UXのための
早期リターン**（400/403を早く返す）と位置づける。最終防御はDB関数側の
`is_facility_member(p_facility_id) OR is_admin()` チェックであり、これを省略しない。

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
- **DB関数の認可バイパステスト**（`supabase/migrations/__tests__` に追加、pgTAP等の既存パターンに
  従う）: 他施設に所属するユーザーとして `get_news_feed` をAPI層を経由せず**直接RPC呼び出し**し、
  他施設の `p_facility_id` を渡すと例外（`FORBIDDEN`）になることを検証する。API Route側のモックや
  スタブでは検出できないため、Next.jsを経由しないDB層単独のテストとして書く

## スコープ外

- 手動お知らせ投稿（案b）は本issueでは対象外。将来必要になれば別issueで検討
- `products` テーブル単体の新規登録通知は対象外
- 既読/未読管理、通知（メール・プッシュ）は対象外
