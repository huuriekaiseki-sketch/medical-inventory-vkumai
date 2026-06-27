# マルチテナント Phase 2 設計

> Phase 1（Magic Linkログイン）完了後に実施。施設ごとのデータ分離とユーザー管理UIを実装する。

## スコープ

- `user_facilities` テーブル作成・RLSポリシー切り替え
- 管理画面（ユーザー一覧・施設割り当て・招待・削除）
- 注文RPC関数への施設メンバーチェック追加

初期シード方針：現在のユーザー（管理者のみ）を全施設に割り当ててからRLSを有効化。

---

## DB層

### 新規テーブル: `user_facilities`

```sql
CREATE TABLE user_facilities (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, facility_id)
);
CREATE INDEX ON user_facilities (user_id, facility_id);
ALTER TABLE user_facilities ENABLE ROW LEVEL SECURITY;

-- 自分の行のみ SELECT 可（RLSサブクエリが空集合にならないために必須）
CREATE POLICY "self_read" ON user_facilities
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- 書き込みは service_role のみ（authenticated にポリシーなし = 書けない）
```

### ヘルパー関数

```sql
CREATE OR REPLACE FUNCTION is_facility_member(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND facility_id = p_facility_id
  );
$$;
```

### 初期シード

```sql
-- 【初期シードのみ】現時点の全ユーザーを全施設に割り当て。
-- 本番ユーザーが増えた後にこのマイグレーションを再実行すると全員が全施設に入るため、
-- 本番適用前に対象ユーザーを条件で絞るか、このブロックを削除すること。
INSERT INTO user_facilities (user_id, facility_id)
SELECT u.id, f.id FROM auth.users u CROSS JOIN facilities f
ON CONFLICT DO NOTHING;
```

### RLSポリシー更新

#### 変更なし（共有テーブル）

`products` / `distributor_products` / `categories` は `USING (true)` のまま。

#### 施設固有・直接型テーブル

対象: `facilities` / `hospital_prices` / `consumables` / `case_orders` / `consumable_orders` / `loan_orders` / `loan_returns`

```sql
DROP POLICY IF EXISTS "auth_only" ON <table>;
CREATE POLICY "facility_member_only" ON <table>
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id))
  WITH CHECK (is_facility_member(facility_id));
```

`facilities` の INSERT は service_role のみ（authenticated はINSERT不可）。

#### 施設固有・親参照型テーブル（`*_items`）

```sql
-- case_order_items
DROP POLICY IF EXISTS "auth_only" ON case_order_items;
CREATE POLICY "facility_member_only" ON case_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND is_facility_member(o.facility_id)
  ));

-- consumable_order_items: consumable_orders 経由
-- loan_order_items: loan_orders 経由
-- loan_return_items: loan_returns 経由
```

#### price_histories（ポリモーフィック・SELECT のみ）

```sql
DROP POLICY IF EXISTS "auth_only" ON price_histories;
CREATE POLICY "facility_member_only" ON price_histories
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN entity_type = 'hospital_price' THEN
        EXISTS (
          SELECT 1 FROM hospital_prices hp
          WHERE hp.id = price_histories.entity_id
            AND is_facility_member(hp.facility_id)
        )
      WHEN entity_type = 'distributor_product' THEN true
      ELSE false
    END
  );
```

`get_distributor_product_price_history` 関数の `hospital_price` 側 UNION にも `is_facility_member` チェックを追加。

### RPC関数への施設チェック追加

`create_case_order_atomic` / `create_loan_order_atomic` / `create_consumable_order_atomic` の冒頭に：

```sql
IF NOT is_facility_member(p_facility_id) THEN
  RAISE EXCEPTION 'forbidden: not a member of this facility';
END IF;
```

---

## API層

### `/api/admin/users/route.ts`

| メソッド | 処理 |
|---|---|
| `GET` | `listUsers()` でユーザー一覧取得。各ユーザーの担当施設IDリストを `user_facilities` から結合して返す |
| `POST` | `inviteUserByEmail(email)` で招待メール送信 |
| `DELETE` | `deleteUser(userId)` でユーザー削除 |

### `/api/admin/user-facilities/route.ts`

| メソッド | 処理 |
|---|---|
| `POST` | `user_facilities` に行を追加（担当施設を割り当て） |
| `DELETE` | `user_facilities` から行を削除（担当施設を外す） |

両ルートの共通処理：
- 冒頭で `getUser()` + `ADMIN_EMAILS` チェック（middleware に加えて二重ガード）
- `SUPABASE_SERVICE_ROLE_KEY` を使う Admin クライアントを使用

---

## UI層

### `/admin/layout.tsx`

管理セクション共通の簡易ヘッダー（「管理画面」ラベル + トップに戻るリンク）。

### `/admin/users/page.tsx`

1ページ完結型。ユーザー行を展開すると施設割り当てチェックボックスが表示される。

```
┌─────────────────────────────────────────────┐
│ ユーザー管理                    [+ 招待]    │
├──────────┬──────────────┬───────────────────┤
│ メール   │ 最終ログイン │ 担当施設          │
├──────────┼──────────────┼───────────────────┤
│ a@b.com  │ 2026-06-27  │ [▼ 展開して設定]  │
│          │              │ □ 施設A           │
│          │              │ ☑ 施設B           │
├──────────┼──────────────┼───────────────────┤
│ c@d.com  │ 未ログイン  │ [▼ 展開して設定]  │
└──────────┴──────────────┴───────────────────┘
```

インタラクション：
- チェックボックス変更 → 即時 `POST/DELETE /api/admin/user-facilities`
- 「招待」ボタン → メール入力モーダル → `POST /api/admin/users` → 成功トースト
- 削除アイコン → 確認ダイアログ → `DELETE /api/admin/users`

---

## 完了条件

1. 担当外施設のデータが API で返ってこない（ネガティブ確認必須）
2. 担当外 `facility_id` で注文 RPC が `forbidden` で拒否される
3. 管理画面からユーザーを招待できる
4. 招待したユーザーに施設を割り当てると、そのユーザーでデータが見える
5. 共有データ（商品・販売店商品・カテゴリ）は全ユーザーに引き続き見える
6. `price_histories`（`entity_type='hospital_price'` 行）が担当外ユーザーに見えない
7. 担当施設では書ける / 担当外では 0 行・拒否されることを主要書き込み操作で確認

---

## ロールバック手順

RLS ポリシーを `USING (true)` に戻し `user_facilities` を TRUNCATE する。
