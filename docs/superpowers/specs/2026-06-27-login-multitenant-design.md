# ログイン機能・マルチテナント設計

## 概要

Supabase Auth（Magic Link）によるログイン機能と、施設ごとのデータ分離（マルチテナント）を2フェーズで実装する。

### 背景

現状、`server.ts` が `SUPABASE_SERVICE_ROLE_KEY` を使用しており、RLSポリシー（15テーブルに設定済み）が完全に無効化されている。本実装でこれを解消する。

---

## データ区分

| 区分 | 対象テーブル | アクセス |
|---|---|---|
| 共有データ | `products` / `distributor_products` / `categories` / `consumables` | 認証済み全ユーザー |
| 施設固有データ | `facilities` / `hospital_prices` / `case_orders` / `case_order_items` / `consumable_orders` / `consumable_order_items` / `loan_orders` / `loan_order_items` / `loan_returns` / `loan_return_items` / `price_histories` | 担当施設のユーザーのみ |

---

## Phase 1: Magic Linkログイン

### 目標

- 未認証ユーザーが `/login` 以外にアクセスできないようにする
- `service_role_key` → SSRセッションクライアントへ切替でRLSを有効化
- 全ページの動作を確認し、データ取得が壊れていないことを担保する

### 認証フロー

```
ユーザーが /login にアクセス
→ メールアドレスを入力・送信
→ Supabase が Magic Link メールを送信
→ ユーザーがリンクをクリック
→ /auth/callback でセッション確立
→ / にリダイレクト
```

### 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/app/login/page.tsx` | 新規 | メール入力フォーム（Magic Link送信） |
| `src/app/auth/callback/route.ts` | 新規 | コールバック処理・セッション確立・リダイレクト |
| `src/middleware.ts` | 変更 | 未認証 → `/login` リダイレクト、`/admin` は `ADMIN_EMAILS` チェック |
| `src/lib/supabase/server.ts` | 変更 | `service_role_key` → `@supabase/ssr` の `createServerClient` に切替 |
| `src/lib/supabase/client.ts` | 新規 | ブラウザ用クライアント（`createBrowserClient`） |

### 環境変数

```
# 既存
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...   # Phase 2 admin API用に残す

# 追加
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
ADMIN_EMAILS=user@example.com   # カンマ区切りで複数可
```

### middlewareの振る舞い

- `/login`、`/auth/callback` はパブリック（認証不要）
- `/admin/*` は認証済みかつ `ADMIN_EMAILS` に含まれるメールのみ許可
- その他すべて：未認証なら `/login` へリダイレクト

### server.tsの切替方針

`@supabase/ssr` の `createServerClient` を使い、Next.jsのCookieを読み書きすることでセッションを管理する。全APIルートがこのクライアントを使うことでRLSが有効になる。

### Phase 1完了条件

1. Magic Linkでログインできる
2. 未認証でアクセスすると `/login` にリダイレクトされる
3. ログイン後、全ナビページ（施設・デバイス・販売店商品・ニュース・コンパチ・その他）でデータが正常に表示される
4. ブラウザDevToolsでAPIが401/403を返していない
5. 既存E2Eスモークテストが通過する

---

## Phase 2: マルチテナント

### 目標

- 施設固有データを担当ユーザーのみ参照・操作できるようにする
- 管理者が担当施設をUIで割り当てられるようにする

### 新規DBスキーマ

```sql
CREATE TABLE user_facilities (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, facility_id)
);
ALTER TABLE user_facilities ENABLE ROW LEVEL SECURITY;
-- 管理者はservice_role_keyで操作するためRLSポリシーは不要
```

### RLSポリシー変更

**共有テーブル（変更なし）:** `USING (true)` のまま維持。

**施設固有テーブル（書き換え）:**

```sql
-- facilities の例
DROP POLICY IF EXISTS "auth_only" ON facilities;
CREATE POLICY "facility_member_only" ON facilities
  FOR ALL TO authenticated
  USING (
    id IN (
      SELECT facility_id FROM user_facilities
      WHERE user_id = auth.uid()
    )
  );

-- hospital_prices の例（facility_id カラム経由）
DROP POLICY IF EXISTS "auth_only" ON hospital_prices;
CREATE POLICY "facility_member_only" ON hospital_prices
  FOR ALL TO authenticated
  USING (
    facility_id IN (
      SELECT facility_id FROM user_facilities
      WHERE user_id = auth.uid()
    )
  );
```

注文系テーブル（`case_orders` 等）も同様に `facility_id` 経由でフィルタする。

`price_histories` は既存ポリシーが `FOR SELECT` のみのため、Phase 2でも `SELECT` 限定で書き換える。

### 管理画面

| ファイル | 内容 |
|---|---|
| `src/app/admin/users/page.tsx` | ユーザー一覧 + 担当施設割り当てUI |
| `src/app/api/admin/users/route.ts` | Supabase Admin API呼び出し（`service_role_key` 使用） |
| `src/app/api/admin/user-facilities/route.ts` | `user_facilities` テーブルのCRUD |

管理画面は `middleware.ts` の `ADMIN_EMAILS` チェックでガード済み。

### Phase 2完了条件

1. `user_facilities` に紐付いていない施設のデータが見えない
2. 管理画面でユーザーに施設を割り当てられる
3. 施設を割り当てた後、そのユーザーで該当施設のデータが見える
4. 共有データ（商品・販売店商品・カテゴリ）は引き続き全ユーザーに見える

---

## リスクと対策

| リスク | 対策 |
|---|---|
| `server.ts` 切替でデータ取得が壊れる | Phase 1完了条件に全ページ動作確認を含める |
| `user_facilities` 未登録ユーザーが施設データを見られなくなる | Phase 2移行時に管理者が先に自分を全施設に割り当てる |
| `/admin` に一般ユーザーがアクセスできる | middleware の `ADMIN_EMAILS` チェックで遮断 |
