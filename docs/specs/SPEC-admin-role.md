# SPEC: Issue #15 + #16 — Admin Role 一元化 & 管理UI Role変更機能

## Part 1: 受け入れ条件

### #16: requireAdmin() をDB roleベースに一元化
- [ ] `requireAdmin()` が `user_facilities.role='admin'` で判定する
- [ ] ADMIN_EMAILS はフォールバック（DBに1件もadminがいない場合のみ有効）
- [ ] `middleware.ts` の admin判定も同じロジックに統一
- [ ] `require-facility-access.ts` の `isAdminUser()` も同じロジックに統一

### #15: 管理UIでrole変更
- [ ] `AdminUser` 型が `facilities: { id: string; role: 'admin'|'staff' }[]` を持つ
- [ ] GET `/api/admin/users` が各施設の role を返す
- [ ] UserTable の施設展開行に admin/staff セレクトボックスが表示される
- [ ] 変更時に POST `/api/admin/user-facilities` へ role を送信する

### マイグレーション（#16デプロイ前提条件）
- [ ] 既存の管理者に該当するユーザーの `user_facilities.role` を `'admin'` に更新するSQLを用意する
- [ ] #16デプロイ前に本番DBで実行し、`user_facilities` に `role='admin'` 行が最低1件存在することを確認する

## Part 2: 実装計画

### 並列グループ宣言

| グループ | エージェント | 触るファイル |
|---|---|---|
| A | contract-writer | `src/types/admin.ts` |
| B | data-impl | `src/lib/admin-auth.ts`, `src/middleware.ts`, `src/lib/supabase/require-facility-access.ts` |
| B | api-impl | `src/app/api/admin/users/route.ts` |
| B | ui-impl | `src/components/admin/UserTable.tsx`, `src/app/admin/users/page.tsx` |

※ db-impl はスキーマ変更不要のためスキップ。マイグレーションSQLは data-impl が `docs/specs/` に出力する。

### 型定義（contract-writer が確定させる）

```ts
// src/types/admin.ts
export type AdminUser = {
  id: string
  email: string
  lastSignInAt: string | null
  facilities: { id: string; role: 'admin' | 'staff' }[]
}
```

### data-impl が提供するインターフェース

```ts
// src/lib/admin-auth.ts
export async function requireAdmin(): Promise<User | null>
// → user_facilities.role='admin' で判定。DBにadminが0件の場合はADMIN_EMAILSでフォールバック

// src/lib/supabase/require-facility-access.ts
export async function isAdminUser(userId: string): Promise<boolean>
// → admin-auth の共通ロジックを呼ぶ（重複実装を解消）
```

### api-impl が参照する変更点

- `user_facilities` SELECT に `role` を追加: `'user_id, facility_id, role'`
- レスポンスの `facilityIds: string[]` を `facilities: { id: string; role: 'admin'|'staff' }[]` に変更
- `AdminUser` マッピングを更新

### ui-impl が参照する変更点

- `UserTable` の施設チェックボックス行に `<select>` を追加（`admin` / `staff`）
- `page.tsx` に `handleChangeRole(userId, facilityId, role)` を追加
- `onToggleFacility` のadd時は role='staff' をデフォルト送信（既存動作維持）
