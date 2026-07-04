# SPEC: 既存API [id]系の認証チェック漏れ・admin判定ロジックの重複解消（Issue #24）

---

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか

- これまで認証なしでアクセスできてしまっていたAPI（商品・施設・カテゴリ・販売店商品・病院価格の詳細取得/更新/削除、価格改定履歴、消耗品登録）が、ログインしていないと401エラーになります。
- 管理者判定（admin判定）のロジックが3箇所（`middleware.ts`／`admin-auth.ts`／`require-facility-access.ts`）にバラバラに実装されていたのを1箇所に統一し、今後ロジックを変更する際に修正漏れが起きにくくなります。
- 現状「DBに管理者が1人もいない場合はADMIN_EMAILS環境変数で緊急ログインできる」というフォールバックが`admin-auth.ts`と`require-facility-access.ts`にはあるのに`middleware.ts`には無く、画面遷移レベルではADMIN_EMAILSでの緊急アクセスがブロックされてしまう状態でした。これを解消します。

### 受け入れ条件（チェックリスト）

**認証チェック追加**
- [ ] 未認証で以下にアクセスすると401が返る
  - `GET/PUT/DELETE /api/products/{id}`
  - `GET/PUT/DELETE /api/facilities/{id}`
  - `GET/PUT/DELETE /api/categories/{id}`
  - `GET/PUT/DELETE /api/distributor-products/{id}`
  - `GET/PUT/DELETE /api/hospital-prices/{id}`
  - `GET /api/distributor-products/{id}/price-history`
  - `POST /api/consumables`
- [ ] `hospital-prices/{id}` は施設スコープのデータのため、認証に加えて`requireFacilityAccess`によるアクセス制御も行われる（他施設の価格情報を更新・削除できない）
- [ ] 既存の正常系（認証済みユーザーのCRUD操作）が今まで通り動作する（既存テスト全通過）

**admin判定ロジックの統一**
- [ ] `middleware.ts`のadmin判定で、DBにrole='admin'の行が1件も無い場合にADMIN_EMAILSへフォールバックする
- [ ] `admin-auth.ts`の`requireAdmin()`と`require-facility-access.ts`の内部実装が、共通の判定ロジックを呼び出す形になっている（同一ロジックの二重実装が解消されている）
- [ ] admin判定のふるまい（DB上の管理者判定→DBに管理者が0件ならADMIN_EMAILSフォールバック）が3箇所すべてで一致している
- [ ] 既存のadmin関連テスト（`admin_rls.test.ts`, `middleware.test.ts`等）が全通過する

### 備考（スコープ外）

- `products`/`categories`/`distributor-products`のRLSを「読み取り全認証ユーザー・書き込みadmin限定」に明確化する話は issue #25（技術負債残作業 SET F）で別途対応する。本issueでは「未認証を弾く」ところまでを対象とし、認証済みユーザー間の権限細分化（読み取り専用ユーザー等）は行わない。
- unsafe enum castの解消・APIレスポンス形式統一・型安全性改善などは issue #25 の対象。

---

## Part 2 — 実装計画（AI用・レビュー不要）

### 前提となる既存実装

- `requireAuth(db): Promise<User>`（`src/lib/supabase/require-auth.ts`）: 未認証は`Error('UNAUTHORIZED')`
- `requireFacilityAccess(db, user, facilityId): Promise<{facilityId}>`（`src/lib/supabase/require-facility-access.ts`）: admin全許可／非adminは所属施設のみ。内部で`isAdminUserWithEmail(user)`を呼んでいる
- `requireAdmin(): Promise<User | null>`（`src/lib/admin-auth.ts`）: DB role='admin'判定＋ADMIN_EMAILSフォールバック
- `middleware.ts`: `/admin*`パスでDB role='admin'のみチェック（ADMIN_EMAILSフォールバックなし）。Edge Runtimeのため`createAdminSupabase()`（service role key）が使えず、セッション付きクライアントで`user_facilities`をRLS越しに問い合わせている
- 各routeの典型パターン（`src/app/api/products/route.ts`等）: `try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }`

### admin判定統一の設計

`requireAdmin()`と`isAdminUserWithEmail()`はどちらも「①自分がrole='admin'か（service role経由でRLSバイパス）→②DB全体にadminが1件でもいるか（いれば非admin確定）→③いなければADMIN_EMAILSフォールバック」という同一ロジックを別々に実装している。

`middleware.ts`はEdge Runtimeでservice role keyが使えないため、同じ実装をそのまま共通化できない。そこで以下のSECURITY DEFINER RPCを新設し、RLSをバイパスしつつservice role keyなしで①②を判定できるようにする。

```sql
-- supabase/migrations/xxxxx_add_admin_status_rpc.sql
CREATE OR REPLACE FUNCTION get_admin_status(p_user_id UUID)
RETURNS TABLE (user_is_admin BOOLEAN, db_has_admin BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_facilities WHERE user_id = p_user_id AND role = 'admin'),
    EXISTS (SELECT 1 FROM user_facilities WHERE role = 'admin');
$$;

GRANT EXECUTE ON FUNCTION get_admin_status TO anon, authenticated, service_role;
```

このRPCは`authenticated`ロールで呼び出し可能（SECURITY DEFINERでRLSをバイパスするが、判定結果のbooleanしか返さないため情報漏洩はない）。`createServerSupabase()`（セッション付き・anon key）からでも`createAdminSupabase()`（service role）からでも同じ結果を得られる。

新設する共通関数（ADMIN_EMAILSはNext.js環境変数でPostgres側から読めないため、フォールバック判定はTS側に残す）：

```typescript
// src/lib/admin-status.ts
export async function resolveIsAdmin(db: SupabaseClient, user: User): Promise<boolean> {
  const { data, error } = await db.rpc('get_admin_status', { p_user_id: user.id })
  if (error || !data || data.length === 0) return false
  const { user_is_admin, db_has_admin } = data[0]
  if (user_is_admin) return true
  if (db_has_admin) return false
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  if (adminEmails.length === 0) return false
  return adminEmails.includes((user.email ?? '').trim().toLowerCase())
}
```

- `admin-auth.ts`の`requireAdmin()`は`resolveIsAdmin(db, user)`を呼ぶだけに簡略化（`createAdminSupabase()`不要になる）
- `require-facility-access.ts`の`isAdminUserWithEmail()`を削除し、`resolveIsAdmin`を直接呼ぶ
- `middleware.ts`はセッション付きクライアントで`resolveIsAdmin`相当のロジックを呼ぶ（RPCなのでEdge Runtimeでも動作する）。ただし`middleware.ts`はNext.js Edge Runtime向けの独立ファイルで`src/lib/`のNode専用コードに依存できない制約があるため、`resolveIsAdmin`が純粋にSupabaseClient+fetchのみに依存する（Node API不使用）ことを確認し、`middleware.ts`から直接importして使う

### 実装セット一覧（依存順）

**Set 1: admin判定統一（DBマイグレーション + 共通関数）** [波A]
- `supabase/migrations/xxxxx_add_admin_status_rpc.sql` 新設（上記RPC）
- `src/lib/admin-status.ts` 新設: `resolveIsAdmin(db, user)`
- テスト観点: 自分がadmin→true、他にadminがいる非admin→false、DBにadmin0件+ADMIN_EMAILS一致→true、DBにadmin0件+ADMIN_EMAILS不一致→false、RPCエラー時→false
- 触るファイル: `supabase/migrations/`, `src/lib/admin-status.ts`（新規）, `.test.ts`（新規）

**Set 2: admin-auth.ts / require-facility-access.ts のリファクタ** [Set1依存]
- `requireAdmin()`を`resolveIsAdmin`呼び出しに置き換え（`createAdminSupabase()`のimportを削除可能なら削除）
- `isAdminUserWithEmail()`を削除し`resolveIsAdmin`を直接呼ぶ
- 既存の外部インターフェース（`requireAdmin(): Promise<User|null>`、`requireFacilityAccess(db,user,facilityId)`）は変更しない（呼び出し元への影響なし）
- テスト観点: 既存の`admin-auth`関連テストがすべて通ること（振る舞い不変のリファクタ）
- 触るファイル: `src/lib/admin-auth.ts`, `src/lib/supabase/require-facility-access.ts`

**Set 3: middleware.ts のADMIN_EMAILSフォールバック追加** [Set1依存]
- 現行の「DB role='admin'チェックのみ」を`resolveIsAdmin`相当のロジック（RPC呼び出し＋ADMIN_EMAILSフォールバック）に置き換え
- テスト観点: DBにadmin0件+ADMIN_EMAILS一致ユーザーで`/admin`にアクセス→通過、不一致→`/login`へリダイレクト
- 触るファイル: `src/middleware.ts`, `src/__tests__/middleware.test.ts`

**Set 4: [id]系ルートへの認証チェック追加（マスタ系、facility非スコープ）** [波B、他セットと独立]
- 対象: `src/app/api/products/[id]/route.ts`, `categories/[id]/route.ts`, `distributor-products/[id]/route.ts`
- 各GET/PUT/DELETEの先頭に既存パターン（`try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }`）を追加
- facilityIdスコープなし（マスタデータのため、認証済みなら誰でも操作可能という既存方針を維持。権限細分化はissue #25）
- テスト観点: 各HTTPメソッドで未認証時401、認証済み時は既存の正常系が壊れないこと
- 触るファイル: 上記3ファイル＋対応する`.test.ts`

**Set 5: facilities/[id]route.tsへの認証チェック追加** [波B]
- 同上パターンをGET/PUT/DELETEに追加
- 触るファイル: `src/app/api/facilities/[id]/route.ts` ＋テスト

**Set 6: hospital-prices/[id]route.tsへの認証+施設アクセス制御追加** [波B]
- GET: `getHospitalPrice`で取得した価格の`facilityId`を使って`requireFacilityAccess(db, user, price.facilityId)`
- PUT: body内の`input.facilityId`で`requireFacilityAccess`（既存の`hospital-prices/route.ts` POSTと同じパターン）
- DELETE: 先に`getHospitalPrice`で対象を取得し、その`facilityId`で`requireFacilityAccess`してから削除
- テスト観点: 未認証401、他施設ユーザーが403、自施設ユーザー/adminは通過
- 触るファイル: `src/app/api/hospital-prices/[id]/route.ts` ＋テスト

**Set 7: price-history route への認証チェック追加** [波B]
- `src/app/api/distributor-products/[id]/price-history/route.ts`のGETに`requireAuth`を追加（マスタ系のためfacilityスコープなし）
- 触るファイル: 同ファイル＋テスト（新規作成）

**Set 8: consumables POSTへの認証・施設アクセス制御追加** [波B]
- 既にimport済みの`requireAuth`/`requireFacilityAccess`をPOSTハンドラでも呼ぶ（GETと同じパターン）
- 触るファイル: `src/app/api/consumables/route.ts` ＋テスト

### 並列グループ宣言

- **波A（Set1が先行、Set2/Set3はSet1完了後に並列可）**: Set1 → (Set2, Set3)
- **波B（波Aと並列に着手可、Set4〜8は互いに別ファイルなので並列可）**: Set4, Set5, Set6, Set7, Set8
- **統合ゲート**: 全セットのマイグレーション適用確認・npm test/lint実行・admin判定の一貫性を横断確認
