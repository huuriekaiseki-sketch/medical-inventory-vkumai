# 価格履歴機能 設計ドキュメント

日付: 2026-06-22  
対象: distributor_products の価格履歴追跡

---

## 概要

`distributor_products` の `reimbursement_price`、および関連する `hospital_prices` の `purchase_price` / `delivery_price` が変更されたとき、DBトリガーで自動的に履歴を記録する。専用ページで変更一覧を確認でき、クリックで詳細を展開できる。

---

## データモデル

### 新テーブル: `price_histories`

```sql
CREATE TABLE price_histories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('distributor_product', 'hospital_price')),
  entity_id   UUID NOT NULL,
  field_name  TEXT NOT NULL CHECK (field_name IN ('reimbursement_price', 'purchase_price', 'delivery_price')),
  old_value   NUMERIC,   -- NULL = 初回設定（前の値がなかった）
  new_value   NUMERIC,   -- NULL = 価格フィールドをクリアした
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_price_histories_entity ON price_histories (entity_type, entity_id);
```

### DBトリガー（2本）

**① distributor_products の reimbursement_price 変更検知**

```sql
CREATE OR REPLACE FUNCTION trg_distributor_products_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.reimbursement_price IS DISTINCT FROM OLD.reimbursement_price THEN
    INSERT INTO price_histories (entity_type, entity_id, field_name, old_value, new_value)
    VALUES ('distributor_product', NEW.id, 'reimbursement_price', OLD.reimbursement_price, NEW.reimbursement_price);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER distributor_products_price_history
AFTER UPDATE ON distributor_products
FOR EACH ROW EXECUTE FUNCTION trg_distributor_products_price_history();
```

**② hospital_prices の purchase_price / delivery_price 変更検知**

```sql
CREATE OR REPLACE FUNCTION trg_hospital_prices_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
    INSERT INTO price_histories (entity_type, entity_id, field_name, old_value, new_value)
    VALUES ('hospital_price', NEW.id, 'purchase_price', OLD.purchase_price, NEW.purchase_price);
  END IF;
  IF NEW.delivery_price IS DISTINCT FROM OLD.delivery_price THEN
    INSERT INTO price_histories (entity_type, entity_id, field_name, old_value, new_value)
    VALUES ('hospital_price', NEW.id, 'delivery_price', OLD.delivery_price, NEW.delivery_price);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hospital_prices_price_history
AFTER UPDATE ON hospital_prices
FOR EACH ROW EXECUTE FUNCTION trg_hospital_prices_price_history();
```

---

## API

### `GET /api/distributor-products/[id]/price-history`

指定した distributor_product に関連する全価格変更履歴を返す。

- `distributor_product` の `reimbursement_price` 変更履歴
- その商品に紐づく全 `hospital_prices` の `purchase_price` / `delivery_price` 変更履歴

レスポンス（`changed_at` 降順）:
```json
{
  "items": [
    {
      "id": "uuid",
      "entityType": "distributor_product",
      "entityId": "uuid",
      "fieldName": "reimbursement_price",
      "oldValue": 1000,
      "newValue": 1200,
      "changedAt": "2026-06-22T10:00:00Z"
    },
    {
      "id": "uuid",
      "entityType": "hospital_price",
      "entityId": "uuid",
      "fieldName": "purchase_price",
      "oldValue": 800,
      "newValue": 900,
      "changedAt": "2026-06-21T09:00:00Z"
    }
  ]
}
```

実装クエリ戦略（2段UNION）:
```sql
-- ① distributor_product 自身の履歴
SELECT ph.*, NULL AS facility_name
FROM price_histories ph
WHERE ph.entity_type = 'distributor_product' AND ph.entity_id = [id]

UNION ALL

-- ② 関連 hospital_prices の履歴（施設名付き）
-- hospital_prices や facilities が削除済みでも履歴行を消さないため LEFT JOIN を使う
SELECT ph.*, f.name AS facility_name
FROM price_histories ph
LEFT JOIN hospital_prices hp ON hp.id = ph.entity_id
LEFT JOIN facilities f ON f.id = hp.facility_id
WHERE ph.entity_type = 'hospital_price'
  AND hp.distributor_product_id = [id]

ORDER BY changed_at DESC
```

facility_name が NULL の場合（施設削除済み）はAPIレスポンスで `facilityName: null` を返し、UIでは「施設情報なし」と表示する。

---

## 型定義

```typescript
// src/types/priceHistory.ts
export type PriceHistoryEntityType = 'distributor_product' | 'hospital_price'
export type PriceHistoryFieldName = 'reimbursement_price' | 'purchase_price' | 'delivery_price'

export interface PriceHistory {
  id: string
  entityType: PriceHistoryEntityType
  entityId: string
  fieldName: PriceHistoryFieldName
  oldValue: number | null
  newValue: number | null
  changedAt: string
  // 施設名（hospital_price の場合のみ。施設が削除済みの場合は null）
  facilityName?: string | null
}
```

---

## UI

### ページ: `/distributor-products/[id]/price-history`

**一覧（テーブル形式）**

| 日時 | 種別 | フィールド | 変更前 | 変更後 |
|------|------|-----------|--------|--------|
| 2026-06-22 10:00 | 償還価格 | — | ¥1,000 | ¥1,200 |
| 2026-06-21 09:00 | 施設価格（A病院） | 仕入価格 | ¥800 | ¥900 |

- 「種別」列: `distributor_product` → 「償還価格」、`hospital_price` → 「施設価格（施設名）」
- 「フィールド」列: `distributor_product` の場合は不要（1フィールドのみ）

**クリックで展開（アコーディオン or インラインパネル）**

詳細表示:
- entity_type（日本語ラベル）
- entity_id（コピー可能なUUID）
- 施設名（hospital_price の場合）
- field_name（日本語ラベル）
- 変更前・後の値（フォーマット済み）
- 変更日時（フル表示）

**ナビゲーション**

- `/distributor-products/[id]/edit` の編集ページに「価格履歴を見る」リンクを追加
- 履歴ページには「← 編集に戻る」リンクを設置

---

## ファイル構成

```
src/
  types/
    priceHistory.ts                                   # 型定義
  lib/
    price-histories/
      repository.ts                                   # DB読み取りロジック
  app/
    api/
      distributor-products/[id]/
        price-history/
          route.ts                                    # GET API
    distributor-products/[id]/
      price-history/
        page.tsx                                      # 履歴ページ
  components/
    price-history/
      PriceHistoryList.tsx                            # 一覧テーブル
      PriceHistoryRow.tsx                             # 行 + 展開詳細
supabase/
  migrations/
    YYYYMMDDHHMMSS_add_price_histories.sql            # DBマイグレーション
```

---

## 制約・注意事項

- 履歴は削除しない（append-only）
- `hospital_prices` が削除された場合、対応する履歴の `entity_id` は孤立するが、問題なし（履歴として保持）
- テーブル権限:
  - `anon`, `authenticated` には **SELECT のみ**付与
  - INSERT は `service_role`（DBトリガー実行コンテキスト）のみ許可
  - トリガー関数は `SECURITY DEFINER` で定義し、postgres ロールの権限で price_histories に INSERT する
  - RLS ポリシーで `anon`/`authenticated` からの直接 INSERT を明示的に DENY する
- INSERT は DBトリガー経由のみ。クライアントからの直接 INSERT は DB 権限レベルで禁止する
