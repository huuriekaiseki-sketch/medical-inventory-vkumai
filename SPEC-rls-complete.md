# SPEC: RLS完全化・施設間データ分離 (issue #4)

## 現状分析

### 既に実装済み（変更不要）
- `user_facilities` テーブル（user_id + facility_id 複合PK）
- `is_facility_member(p_facility_id)` ヘルパー関数
- 施設別 RLS ポリシー `facility_member_only`（orders系・hospital_prices・consumables）
- API routes は `createServerSupabase()`（anon_key + session cookie）を使用 ← RLS有効

### 実装ギャップ

| # | 問題 | 影響 |
|---|------|------|
| G1 | `user_facilities` に `role` カラムがない | admin が全施設にアクセスする RLS 条件を書けない |
| G2 | RLS ポリシーが `is_admin()` をチェックしない | admin ユーザーも自分の施設しか見えない |
| G3 | API が `body.facilityId` をそのまま信頼 | DB レベルでは RLS が弾くが、API 層の意図が曖昧 |
| G4 | GET 系 API にセッション認証チェックがない | middleware 頼みで API 単体テストが書きづらい |

> **注**: G3 は RLS が正しく動いていれば偽装しても他施設のデータは返らない。
> しかし「facilityId をリクエストで偽装しても DB レベルで拒否される」という受け入れ条件は現状でも満たせる。
> G1/G2 が最優先（admin アクセスが完全に壊れている）。

---

## 実装計画

### Task 1: DBマイグレーション（role カラム + is_admin 関数）

**ファイル**: `supabase/migrations/20260628010000_add_role_to_user_facilities.sql`

```sql
-- user_facilities に role カラムを追加
ALTER TABLE user_facilities ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE user_facilities ADD CONSTRAINT user_facilities_role_check
  CHECK (role IN ('staff', 'admin'));

-- 既存の admin ユーザー（ADMIN_EMAILS と照合）は後で手動 UPDATE または API 経由で設定

-- is_admin() ヘルパー関数
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;
```

**RLS ポリシー更新**: 既存 `facility_member_only` ポリシーを更新

```sql
-- 例: consumable_orders
DROP POLICY "facility_member_only" ON consumable_orders;
CREATE POLICY "facility_member_or_admin" ON consumable_orders
  FOR ALL TO authenticated
  USING (is_facility_member(facility_id) OR is_admin())
  WITH CHECK (is_facility_member(facility_id) OR is_admin());
-- 他の対象テーブルも同様: case_orders, loan_orders, loan_returns, hospital_prices, consumables, facilities
-- items テーブルも JOIN 先の order の is_admin() チェックに更新
```

### Task 2: admin/user-facilities API に role 書き込みを追加

**ファイル**: `src/app/api/admin/user-facilities/route.ts`

POST body に `role?: 'staff' | 'admin'` を追加して `user_facilities.role` を設定可能にする。

### Task 3: API 認証チェックヘルパー追加

**ファイル**: `src/lib/supabase/require-auth.ts` （新規）

```ts
export async function requireAuth(db: SupabaseClient) {
  const { data: { user } } = await db.auth.getUser()
  if (!user) throw new Error('UNAUTHORIZED')
  return user
}
```

GET 系 API（orders 一覧など）で `requireAuth` を呼び出してセッション確認を明示。
（ミドルウェアが保護しているため実質的な追加効果は薄いが、API 単体で意図が明確になる）

### Task 4: facilityId のセッション取得ヘルパー（オプション）

POST 系 API で `body.facilityId` ではなくセッションから取得する方向性：

```ts
// src/lib/supabase/get-facility-id.ts
export async function getFacilityIdFromSession(db: SupabaseClient, user: User): Promise<string> {
  const { data } = await db
    .from('user_facilities')
    .select('facility_id')
    .eq('user_id', user.id)
    .single()
  if (!data) throw new Error('施設が割り当てられていません')
  return data.facility_id
}
```

> **決定が必要な点**: 1ユーザーが複数施設に属する場合（admin 含む）、どう扱うか？
> - **案A**: admin は `body.facilityId` 必須（admin は複数施設操作するため選択が必要）
> - **案B**: staff のみセッション自動取得、admin は body から取得
> - **案C**: フロントに「現在の施設」選択 UI を追加し、選択をセッション Cookie で保持

---

## スコープ外（今回やらない）

- ログイン UI の新規実装（既存 `/login/page.tsx` を使用）
- 初回ログイン時の施設割り当てフロー（管理者が admin API で手動設定）
- products/categories/distributor_products の施設別 RLS（共有マスタとして維持）
- API レスポンス形式の統一（別 issue で対応）

---

## 受け入れ条件

- [ ] 施設 A の staff ユーザーが施設 B の orders を GET しても空配列が返る（RLS で行フィルタ）
- [ ] 施設 A の staff ユーザーが `facilityId=B` で POST しても 500 エラー（RPC の `is_facility_member` が RAISE EXCEPTION）
- [ ] role='admin' のユーザーは全施設の orders を取得できる
- [ ] admin/user-facilities API で role 設定ができる
- [ ] 既存の全テストが PASS のまま（現在 306 件）

---

## ファイル変更一覧

| ファイル | 変更 |
|---------|------|
| `supabase/migrations/20260628010000_add_role_to_user_facilities.sql` | 新規 |
| `supabase/migrations/20260628010001_update_rls_admin.sql` | 新規 |
| `src/lib/supabase/require-auth.ts` | 新規 |
| `src/lib/supabase/get-facility-id.ts` | 新規（Task 4 採用時） |
| `src/app/api/admin/user-facilities/route.ts` | role 追加 |
| `src/app/api/admin/user-facilities/__tests__/route.test.ts` | テスト追加 |

---

## 未決事項（人間が決めること）

**Q: facilityId の取得方法（Task 4）はどうする？**
- 案A: 現状維持（body.facilityId を使用、RLS が保護）→ 最小変更
- 案B: staff はセッション自動取得、admin は body.facilityId → API 変更中規模
- 案C: 「現在の施設」セッション管理を追加 → フロント変更大
