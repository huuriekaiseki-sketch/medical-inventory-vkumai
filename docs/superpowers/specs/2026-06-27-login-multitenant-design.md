# ログイン機能・マルチテナント設計（改訂版）

> Opusによる多角的レビュー（セキュリティ・データ整合性・実装リスク）を受けて改訂。

## 概要

Supabase Auth（Magic Link）によるログイン機能と、施設ごとのデータ分離（マルチテナント）を2フェーズで実装する。

### 背景

現状、`server.ts` が `SUPABASE_SERVICE_ROLE_KEY` を使用しており、RLSポリシー（15テーブルに設定済み）が完全に無効化されている。本実装でこれを解消する。

---

## データ区分（実スキーマ確認済み）

| 区分 | 対象テーブル | アクセス |
|---|---|---|
| 共有データ | `products` / `distributor_products` / `categories` | 認証済み全ユーザー |
| 施設固有・直接型（facility_id保持） | `facilities` / `hospital_prices` / `consumables` / `case_orders` / `consumable_orders` / `loan_orders` / `loan_returns` | 担当施設のユーザーのみ |
| 施設固有・親参照型（facility_id なし） | `case_order_items` / `consumable_order_items` / `loan_order_items` / `loan_return_items` | 親テーブル経由EXISTSで施設フィルタ |
| 混在（ポリモーフィック） | `price_histories` | entity_typeで分岐フィルタ（後述） |

> **修正点**: `consumables` は `facility_id NOT NULL` の施設固有テーブルのため共有データから移動。
> `*_items` 明細テーブルは `facility_id` カラムを持たないため「親参照型」として分類。

---

## Phase 1: Magic Linkログイン

### 目標

- 未認証ユーザーが `/login` 以外にアクセスできないようにする
- `service_role_key` → SSRセッションクライアントへ切替でRLSを有効化
- 12のrepositoryファイルへのDI改修を含む（server.tsはsingleton不可のため）
- 全ページの動作確認・E2Eテスト更新で破壊がないことを担保する

### 認証フロー

```
ユーザーが /login にアクセス
→ メールアドレスを入力・送信
→ Supabase が Magic Link メールを送信（emailRedirectTo: NEXT_PUBLIC_SITE_URL/auth/callback）
→ ユーザーがリンクをクリック
→ /auth/callback でPKCEコード交換・セッション確立
→ / にリダイレクト
```

### 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/app/login/page.tsx` | 新規 | メール入力フォーム（Magic Link送信） |
| `src/app/auth/callback/route.ts` | 新規 | PKCEコード交換・セッション確立・リダイレクト |
| `src/middleware.ts` | 変更 | `getUser()`署名検証で未認証→`/login`リダイレクト、`/admin`はADMIN_EMAILSチェック |
| `src/lib/supabase/server.ts` | 変更 | singleton → ファクトリ関数 `createServerSupabase()` に変更 |
| `src/lib/supabase/client.ts` | 新規 | ブラウザ用クライアント（`createBrowserClient`） |
| `src/lib/*/repository.ts` × 12 | 変更 | singleton import → `createServerSupabase()` をDI引数で受け取る形に変更 |
| `src/app/api/*/route.ts` 全ファイル | 変更 | `createServerSupabase()`でクライアント生成し repository に渡す |
| `src/lib/price-histories/__tests__/repository.test.ts` | 変更 | モッククライアントをDI引数で渡す形に更新 |
| `e2e/smoke.spec.ts` | 変更 | Playwright global-setup で事前ログイン（storageState）を追加 |

### server.tsのDI方針

```typescript
// 変更前（singleton）
export const supabase = createClient(url, serviceRoleKey)

// 変更後（ファクトリ関数）
export function createServerSupabase() {
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookies().getAll(),
      setAll: (cookiesToSet) => { /* response cookieに書き込み */ }
    }
  })
}
```

各 `route.ts` でクライアントを生成し、repository 関数に引数として渡す。
トークンリフレッシュは `middleware.ts` の `updateSession` パターンで行い、レスポンスCookieに書き戻す。

### 環境変数

```
# 既存
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...   # Phase 2 admin API用・Admin APIルートのみで使用

# 追加
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SITE_URL=https://...   # Magic LinkのredirectTo先
ADMIN_EMAILS=user@example.com      # カンマ区切りで複数可・小文字trim正規化
```

### middlewareの振る舞い

- `/login`、`/auth/callback` はパブリック（認証不要）
- `/admin/*` および `/api/admin/*` は認証済みかつ `ADMIN_EMAILS` に含まれるメールのみ許可
  - `getUser()`（Authサーバ署名検証）でメールを取得・比較（`getSession()`は使わない）
  - email は小文字化・trim正規化してから比較
- その他すべて：未認証なら `/login` へリダイレクト
- 現在の matcher `['/api/:path*']` を全パス対象に拡張

### /auth/callback のセキュリティ

- PKCEの `code_verifier` Cookie は `HttpOnly+Secure+SameSite=Lax`
- `exchangeCodeForSession` 失敗時は `/login?error=auth` へリダイレクト
- リダイレクト先はハードコード（`next` パラメータ使用時は許可リスト検証）

### E2Eテスト対応

Playwright の `global-setup.ts` でMagic Link認証はメール依存のため Supabase Admin API（`createClient(url, serviceRoleKey)`）でテストユーザーのセッションを直接発行し `storageState` に保存する。

### Phase 1完了条件

1. Magic Linkでログインできる
2. 未認証でアクセスすると `/login` にリダイレクトされる
3. ログイン後、全ナビページ（施設・デバイス・販売店商品・ニュース・コンパチ・その他）でデータが正常に表示される
4. 主要書き込み操作（注文作成・価格更新・消耗品登録）が正常に動作する
5. ブラウザDevToolsでAPIが401/403/500を返していない
6. E2Eスモークテスト（認証セットアップ追加後）が全7ケース通過する
7. セッション有効期限経過後もリフレッシュされ401が出ない（middleware updateSession確認）

---

## Phase 2: マルチテナント

### 目標

- 施設固有データを担当ユーザーのみ参照・操作できるようにする
- 管理者が担当施設をUIで割り当てられるようにする

### 移行手順（順序厳守）

1. `user_facilities` テーブルを作成
2. **既存ユーザー全員を全施設に割り当て**（または管理者ユーザーを全施設に割り当て）を先に実行
3. 同一マイグレーション内でRLSポリシーを切り替え
4. ロールバック手順：ポリシーを `USING (true)` に戻しuser_facilitiesをTRUNCATE

### 新規DBスキーマ

```sql
CREATE TABLE user_facilities (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, facility_id)
);
CREATE INDEX ON user_facilities (user_id, facility_id);

ALTER TABLE user_facilities ENABLE ROW LEVEL SECURITY;
-- 自分の行のみSELECT可（RLSサブクエリが空集合にならないために必須）
CREATE POLICY "self_read" ON user_facilities
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- 書き込みは service_role のみ（ポリシー無し + GRANT なしで遮断）
-- anon への GRANT は付与しない
```

### RLSポリシー変更

#### RLSヘルパー関数（再帰回避・プラン安定化）

```sql
CREATE OR REPLACE FUNCTION is_facility_member(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND facility_id = p_facility_id
  );
$$;
```

#### 共有テーブル（変更なし）

`products` / `distributor_products` / `categories`: `USING (true)` のまま維持。

#### 施設固有・直接型テーブル

```sql
-- facilities / hospital_prices / consumables / case_orders / consumable_orders / loan_orders / loan_returns 共通パターン
DROP POLICY IF EXISTS "auth_only" ON <table>;
CREATE POLICY "facility_member_only" ON <table>
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id))
  WITH CHECK (is_facility_member(facility_id));
```

`facilities` の新規作成は admin の service_role 経由のみ許可（authenticated ユーザーはINSERT不可）。

#### 施設固有・親参照型テーブル（*_items）

```sql
-- case_order_items の例
DROP POLICY IF EXISTS "auth_only" ON case_order_items;
CREATE POLICY "facility_member_only" ON case_order_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM case_orders o
      WHERE o.id = case_order_items.case_order_id
        AND is_facility_member(o.facility_id)
    )
  );
-- consumable_order_items: consumable_orders 経由
-- loan_order_items: loan_orders 経由
-- loan_return_items: loan_returns 経由
```

#### price_histories（ポリモーフィック・SELECTのみ）

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
      WHEN entity_type = 'distributor_product' THEN
        true  -- 共有データ扱い
      ELSE false
    END
  );
```

`get_distributor_product_price_history` 関数内の `hospital_price` 側 UNION にも `is_facility_member` チェックを追加。

#### 注文RPC（SECURITY DEFINERの穴を塞ぐ）

`create_case_order_atomic` / `create_loan_order_atomic` / `create_consumable_order_atomic` の各RPC冒頭に施設メンバーチェックを追加：

```sql
IF NOT EXISTS (
  SELECT 1 FROM user_facilities
  WHERE user_id = auth.uid() AND facility_id = p_facility_id
) THEN
  RAISE EXCEPTION 'forbidden: not a member of this facility';
END IF;
```

### 管理画面

| ファイル | 内容 |
|---|---|
| `src/app/admin/users/page.tsx` | ユーザー一覧 + 担当施設割り当てUI |
| `src/app/api/admin/users/route.ts` | Supabase Admin API呼び出し（`service_role_key` 使用）、冒頭でgetUser+ADMIN_EMAILSを再チェック |
| `src/app/api/admin/user-facilities/route.ts` | `user_facilities` テーブルのCRUD（service_role_key使用）、冒頭で同様に再チェック |

管理画面は `middleware.ts` の `ADMIN_EMAILS` チェックで一次ガード、各APIルートでも二重チェック。

### Phase 2完了条件

1. `user_facilities` に紐付いていない施設のデータが見えない（**ネガティブ確認必須**）
2. 担当外 `facility_id` を渡した注文RPCが `forbidden` エラーで拒否される
3. 管理画面でユーザーに施設を割り当てられる
4. 施設を割り当てた後、そのユーザーで該当施設のデータが見える
5. 共有データ（商品・販売店商品・カテゴリ）は引き続き全ユーザーに見える
6. price_historiesの施設固有行（entity_type='hospital_price'）が担当外ユーザーに見えない
7. 担当施設では書ける / 担当外では0行・拒否されることを主要書き込み操作で確認

---

## リスクと対策

| リスク | 対策 |
|---|---|
| `server.ts` 切替でデータ取得が壊れる | Phase 1完了条件4・5に書き込み確認を含める |
| `user_facilities` 未登録ユーザーが施設データを見られなくなる | Phase 2マイグレーションで先に全ユーザーを全施設に割り当ててからポリシー切替 |
| `/admin` に一般ユーザーがアクセスできる | middleware + 各APIルートの二重チェック |
| 注文RPCがRLSをバイパスし他施設へ発注される | RPC冒頭にuser_facilitiesチェックを追加 |
| `*_items` への直接クエリで全施設明細が漏洩 | 親テーブル経由EXISTSポリシーで遮断 |
| `is_facility_member` ヘルパー関数の再帰 | STABLE + SECURITY DEFINER + search_path固定で安全化 |
| セッション早期切れ・401散発 | middleware の updateSession パターンでトークンリフレッシュを担保 |
