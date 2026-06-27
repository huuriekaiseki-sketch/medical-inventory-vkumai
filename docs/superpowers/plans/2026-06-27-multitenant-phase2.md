# マルチテナント Phase 2 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `user_facilities` テーブルによる施設アクセス制御と管理画面（ユーザー招待・施設割り当て）を実装する。

**Architecture:** DBマイグレーションで `user_facilities` テーブル + RLSポリシーを切り替え、Next.js の Admin API ルートで Supabase Admin API をラップし、`/admin/users` ページで管理UIを提供する。

**Tech Stack:** Next.js 15 App Router, Supabase (PostgreSQL + RLS + SECURITY DEFINER関数), @supabase/ssr, Vitest, @testing-library/react, Tailwind CSS

## Global Constraints

- テストは Vitest + @testing-library/react（`npm test` で実行）
- API ルートは `createAdminSupabase()` を使用（`src/lib/supabase/server.ts` に既存）
- エラーレスポンスは `apiError()` で統一（`src/lib/api-error.ts` に既存）
- マイグレーションファイルは `supabase/migrations/` に配置、名前は `YYYYMMDDHHMMSS_*.sql`
- 既存のUIスタイル：背景 `#EDEADE`、ヘッダー `#072C2C`、テキスト `#111827`、Tailwind CSS
- コミットは各タスク完了時に1回

---

## ファイル構成

| ファイル | 種別 | 責務 |
|---|---|---|
| `supabase/migrations/20260627010000_add_multitenant.sql` | 新規 | user_facilities テーブル + is_facility_member 関数 + 初期シード + RLS切り替え（全て同一マイグレーション） |
| `supabase/migrations/20260627010001_update_order_rpcs.sql` | 新規 | 注文RPC関数への施設メンバーチェック追加 |
| `src/types/admin.ts` | 新規 | AdminUser 型定義 |
| `src/app/api/admin/users/route.ts` | 新規 | GET（一覧）/ POST（招待）/ DELETE（削除） |
| `src/app/api/admin/user-facilities/route.ts` | 新規 | POST（割り当て追加）/ DELETE（割り当て削除） |
| `src/app/api/admin/users/__tests__/route.test.ts` | 新規 | admin/users ルートのユニットテスト |
| `src/app/api/admin/user-facilities/__tests__/route.test.ts` | 新規 | admin/user-facilities ルートのユニットテスト |
| `src/app/admin/layout.tsx` | 新規 | 管理セクション共通ヘッダー |
| `src/app/admin/users/page.tsx` | 新規 | ユーザー管理ページ（Client Component — state管理のため） |
| `src/components/admin/UserTable.tsx` | 新規 | ユーザー一覧テーブル（Client Component）施設チェックボックス・削除 |
| `src/components/admin/InviteModal.tsx` | 新規 | ユーザー招待モーダル（Client Component） |
| `src/components/admin/__tests__/UserTable.test.tsx` | 新規 | UserTable コンポーネントテスト |
| `src/components/admin/__tests__/InviteModal.test.tsx` | 新規 | InviteModal コンポーネントテスト |

---

## Task 1: DBマイグレーション A — user_facilities + RLS切り替え

**Files:**
- Create: `supabase/migrations/20260627010000_add_multitenant.sql`

**Interfaces:**
- Produces: `is_facility_member(p_facility_id UUID) RETURNS BOOLEAN` 関数（Task 2 のマイグレーションが参照）

- [ ] **Step 1: マイグレーションファイルを作成する**

`supabase/migrations/20260627010000_add_multitenant.sql` を以下の内容で作成：

```sql
-- supabase/migrations/20260627010000_add_multitenant.sql
-- WHY: user_facilities テーブルでユーザーと施設の対応を管理し、
--      RLS を施設メンバーのみに絞ることでデータ分離を実現する。
--      同一マイグレーション内で初期シード → ポリシー切り替えの順序を守る。

-- =========================================================================
-- 1. user_facilities テーブル
-- =========================================================================
CREATE TABLE user_facilities (
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES facilities(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, facility_id)
);
CREATE INDEX ON user_facilities (user_id, facility_id);
ALTER TABLE user_facilities ENABLE ROW LEVEL SECURITY;

-- 自分の行のみ SELECT 可（RLS サブクエリが空集合にならないために必須）
CREATE POLICY "self_read" ON user_facilities
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- 書き込みは service_role のみ（authenticated にポリシーなし = 書けない）

-- =========================================================================
-- 2. is_facility_member ヘルパー関数
-- =========================================================================
CREATE OR REPLACE FUNCTION is_facility_member(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities
    WHERE user_id = auth.uid() AND facility_id = p_facility_id
  );
$$;

-- =========================================================================
-- 3. 初期シード（現時点の全ユーザーを全施設に割り当て）
-- =========================================================================
-- 【初期シードのみ】現時点の全ユーザーを全施設に割り当て。
-- 本番ユーザーが増えた後にこのマイグレーションを再実行すると全員が全施設に入るため、
-- 本番適用前に対象ユーザーを条件で絞るか、このブロックを削除すること。
INSERT INTO user_facilities (user_id, facility_id)
SELECT u.id, f.id FROM auth.users u CROSS JOIN facilities f
ON CONFLICT DO NOTHING;

-- =========================================================================
-- 4. 施設固有・直接型テーブルの RLS ポリシーを切り替え
-- =========================================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hospital_prices', 'consumables',
    'case_orders', 'consumable_orders', 'loan_orders', 'loan_returns'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_only" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "facility_member_only" ON %I FOR ALL TO authenticated ' ||
      'USING (is_facility_member(facility_id)) ' ||
      'WITH CHECK (is_facility_member(facility_id))',
      t
    );
  END LOOP;
END
$$;

-- facilities は SELECT/UPDATE のみ（INSERT は service_role = 管理者API経由）
DROP POLICY IF EXISTS "auth_only" ON facilities;
CREATE POLICY "facility_member_only" ON facilities
  FOR SELECT TO authenticated
  USING (is_facility_member(id));
CREATE POLICY "facility_member_update" ON facilities
  FOR UPDATE TO authenticated
  USING (is_facility_member(id))
  WITH CHECK (is_facility_member(id));

-- =========================================================================
-- 5. 施設固有・親参照型テーブル（*_items）の RLS ポリシーを切り替え
-- =========================================================================
DROP POLICY IF EXISTS "auth_only" ON case_order_items;
CREATE POLICY "facility_member_only" ON case_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM case_orders o
    WHERE o.id = case_order_items.case_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON consumable_order_items;
CREATE POLICY "facility_member_only" ON consumable_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM consumable_orders o
    WHERE o.id = consumable_order_items.consumable_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON loan_order_items;
CREATE POLICY "facility_member_only" ON loan_order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_orders o
    WHERE o.id = loan_order_items.loan_order_id
      AND is_facility_member(o.facility_id)
  ));

DROP POLICY IF EXISTS "auth_only" ON loan_return_items;
CREATE POLICY "facility_member_only" ON loan_return_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM loan_returns r
    WHERE r.id = loan_return_items.loan_return_id
      AND is_facility_member(r.facility_id)
  ));

-- =========================================================================
-- 6. price_histories（ポリモーフィック・SELECT のみ）
-- =========================================================================
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

-- =========================================================================
-- 7. get_distributor_product_price_history 関数に施設チェックを追加
-- =========================================================================
CREATE OR REPLACE FUNCTION get_distributor_product_price_history(
  p_distributor_product_id UUID
)
RETURNS TABLE (
  id                     UUID,
  entity_type            TEXT,
  entity_id              UUID,
  dist_product_id        UUID,
  field_name             TEXT,
  old_value              NUMERIC,
  new_value              NUMERIC,
  changed_at             TIMESTAMPTZ,
  facility_name          TEXT
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id AS dist_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    NULL::TEXT AS facility_name
  FROM price_histories ph
  WHERE ph.entity_type = 'distributor_product'
    AND ph.distributor_product_id = p_distributor_product_id

  UNION ALL

  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id AS dist_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    f.name AS facility_name
  FROM price_histories ph
  LEFT JOIN hospital_prices hp ON hp.id = ph.entity_id
  LEFT JOIN facilities f ON f.id = hp.facility_id
  WHERE ph.entity_type = 'hospital_price'
    AND ph.distributor_product_id = p_distributor_product_id
    AND is_facility_member(hp.facility_id)

  ORDER BY changed_at DESC;
$$;
```

- [ ] **Step 2: ローカル Supabase にマイグレーションを適用して確認する**

```bash
npx supabase db push
```

期待出力: `Applying migration 20260627010000_add_multitenant.sql...` が成功すること。

エラーが出た場合は `npx supabase db reset` で一旦リセットしてから再実行。

- [ ] **Step 3: テーブルと関数の作成を確認する**

Supabase Studio (http://localhost:54323) で以下を確認：
- `user_facilities` テーブルが存在する
- `is_facility_member` 関数が存在する
- `user_facilities` に現在のユーザーのレコードが入っている

- [ ] **Step 4: コミットする**

```bash
git add supabase/migrations/20260627010000_add_multitenant.sql
git commit -m "feat: add user_facilities table, is_facility_member function, and RLS policies"
```

---

## Task 2: DBマイグレーション B — 注文RPCへの施設チェック追加

**Files:**
- Create: `supabase/migrations/20260627010001_update_order_rpcs.sql`

**Interfaces:**
- Consumes: `is_facility_member(UUID)` 関数（Task 1 で作成済み）

- [ ] **Step 1: マイグレーションファイルを作成する**

`supabase/migrations/20260627010001_update_order_rpcs.sql` を以下の内容で作成：

```sql
-- supabase/migrations/20260627010001_update_order_rpcs.sql
-- WHY: SECURITY DEFINER 関数は RLS をバイパスするため、
--      担当外施設への注文を冒頭の明示チェックで防ぐ。

-- 症例発注
CREATE OR REPLACE FUNCTION create_case_order_atomic(
  p_facility_id UUID,
  p_case_datetime TIMESTAMPTZ,
  p_procedure_name TEXT,
  p_patient_id TEXT,
  p_patient_initials TEXT,
  p_gender TEXT,
  p_doctor_name TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order case_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO case_orders (
    facility_id, case_datetime, procedure_name,
    patient_id, patient_initials, gender, doctor_name
  ) VALUES (
    p_facility_id, p_case_datetime, p_procedure_name,
    p_patient_id, p_patient_initials, p_gender, p_doctor_name
  )
  RETURNING * INTO v_order;

  INSERT INTO case_order_items (case_order_id, jan, lot, ubd, quantity)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'lot',
    elem->>'ubd',
    COALESCE((elem->>'quantity')::INTEGER, 1)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM case_order_items i
  WHERE i.case_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

-- 短貸発注
CREATE OR REPLACE FUNCTION create_loan_order_atomic(
  p_facility_id UUID,
  p_procedure_name TEXT,
  p_maker TEXT,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order loan_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO loan_orders (facility_id, procedure_name, maker)
  VALUES (p_facility_id, p_procedure_name, p_maker)
  RETURNING * INTO v_order;

  INSERT INTO loan_order_items (loan_order_id, jan, name, quantity)
  SELECT
    v_order.id,
    elem->>'jan',
    elem->>'name',
    COALESCE((elem->>'quantity')::INTEGER, 1)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM loan_order_items i
  WHERE i.loan_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

-- 消耗品発注
CREATE OR REPLACE FUNCTION create_consumable_order_atomic(
  p_facility_id UUID,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order consumable_orders%ROWTYPE;
  v_items JSONB;
BEGIN
  IF NOT is_facility_member(p_facility_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this facility';
  END IF;

  INSERT INTO consumable_orders (facility_id)
  VALUES (p_facility_id)
  RETURNING * INTO v_order;

  INSERT INTO consumable_order_items (consumable_order_id, consumable_id, quantity)
  SELECT
    v_order.id,
    (elem->>'consumable_id')::UUID,
    COALESCE((elem->>'quantity')::INTEGER, 1)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::JSONB)) AS elem;

  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at), '[]'::JSONB)
  INTO v_items
  FROM consumable_order_items i
  WHERE i.consumable_order_id = v_order.id;

  RETURN to_jsonb(v_order) || jsonb_build_object('items', v_items);
END;
$$;

GRANT EXECUTE ON FUNCTION create_case_order_atomic(UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION create_loan_order_atomic(UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION create_consumable_order_atomic(UUID, JSONB) TO authenticated;
```

- [ ] **Step 2: マイグレーションを適用する**

```bash
npx supabase db push
```

期待出力: `Applying migration 20260627010001_update_order_rpcs.sql...` が成功すること。

- [ ] **Step 3: 担当外施設へのRPC呼び出しが拒否されることを確認する**

Supabase Studio の SQL Editor で以下を実行（担当外の facility_id を使用）：

```sql
-- ランダムな UUID（存在しない施設ID）で呼び出す
SELECT create_case_order_atomic(
  '00000000-0000-0000-0000-000000000000'::UUID,
  now(), 'test', 'P001', 'TS', 'M', 'Dr.Test', '[]'::JSONB
);
```

期待結果: `ERROR: forbidden: not a member of this facility`

- [ ] **Step 4: コミットする**

```bash
git add supabase/migrations/20260627010001_update_order_rpcs.sql
git commit -m "feat: add facility member check to order RPC functions"
```

---

## Task 3: Admin API ルート

**Files:**
- Create: `src/types/admin.ts`
- Create: `src/app/api/admin/users/route.ts`
- Create: `src/app/api/admin/user-facilities/route.ts`
- Create: `src/app/api/admin/users/__tests__/route.test.ts`
- Create: `src/app/api/admin/user-facilities/__tests__/route.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/users` → `{ users: AdminUser[] }`
  - `POST /api/admin/users` body: `{ email: string }` → `{ message: string }`
  - `DELETE /api/admin/users` body: `{ userId: string }` → `{ message: string }`
  - `POST /api/admin/user-facilities` body: `{ userId: string, facilityId: string }` → `{ message: string }`
  - `DELETE /api/admin/user-facilities` body: `{ userId: string, facilityId: string }` → `{ message: string }`

```typescript
// src/types/admin.ts
export type AdminUser = {
  id: string
  email: string
  lastSignInAt: string | null
  facilityIds: string[]
}
```

- [ ] **Step 1: 型定義ファイルを作成する**

`src/types/admin.ts` を以下の内容で作成：

```typescript
export type AdminUser = {
  id: string
  email: string
  lastSignInAt: string | null
  facilityIds: string[]
}
```

- [ ] **Step 2: admin/users ルートのテストを書く**

`src/app/api/admin/users/__tests__/route.test.ts` を以下の内容で作成：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockListUsers = vi.fn()
const mockInviteUserByEmail = vi.fn()
const mockDeleteUser = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({
    auth: {
      admin: {
        listUsers: mockListUsers,
        inviteUserByEmail: mockInviteUserByEmail,
        deleteUser: mockDeleteUser,
      },
    },
    from: mockFrom,
  }),
  createServerSupabase: () => ({
    auth: { getUser: mockGetUser },
  }),
}))

const ADMIN_EMAIL = 'admin@test.com'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { email: ADMIN_EMAIL } },
  })
})

describe('GET /api/admin/users', () => {
  it('ユーザー一覧と担当施設IDを返す', async () => {
    mockListUsers.mockResolvedValue({
      data: {
        users: [
          { id: 'u1', email: 'a@test.com', last_sign_in_at: '2026-06-27T00:00:00Z' },
        ],
      },
      error: null,
    })
    const mockSelect = vi.fn().mockReturnThis()
    const mockEq = vi.fn().mockResolvedValue({
      data: [{ facility_id: 'f1' }],
      error: null,
    })
    mockFrom.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ eq: mockEq })

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.users[0].id).toBe('u1')
    expect(body.users[0].facilityIds).toEqual(['f1'])
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const res = await GET()
    expect(res.status).toBe(403)
  })
})

describe('POST /api/admin/users', () => {
  it('招待メールを送信して 200 を返す', async () => {
    mockInviteUserByEmail.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@test.com' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInviteUserByEmail).toHaveBeenCalledWith('new@test.com')
  })

  it('email 未指定は 400 を返す', async () => {
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/users', () => {
  it('ユーザーを削除して 200 を返す', async () => {
    mockDeleteUser.mockResolvedValue({ error: null })
    const req = new NextRequest('http://localhost/api/admin/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(mockDeleteUser).toHaveBeenCalledWith('u1')
  })
})
```

- [ ] **Step 3: テストが RED になることを確認する**

```bash
npm test src/app/api/admin/users/__tests__/route.test.ts
```

期待: `Cannot find module '../route'` などのエラーで FAIL。

- [ ] **Step 4: admin/users ルートを実装する**

`src/app/api/admin/users/route.ts` を以下の内容で作成：

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server'
import { apiError } from '@/lib/api-error'
import type { AdminUser } from '@/types/admin'

async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  const email = user?.email?.trim().toLowerCase() ?? ''
  if (!user || !adminEmails.includes(email)) return null
  return user
}

export async function GET() {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const admin = createAdminSupabase()
  const { data, error } = await admin.auth.admin.listUsers()
  if (error) return apiError(error.message)

  const users: AdminUser[] = await Promise.all(
    data.users.map(async (u) => {
      const { data: rows } = await admin
        .from('user_facilities')
        .select('facility_id')
        .eq('user_id', u.id)
      return {
        id: u.id,
        email: u.email ?? '',
        lastSignInAt: u.last_sign_in_at ?? null,
        facilityIds: (rows ?? []).map((r: { facility_id: string }) => r.facility_id),
      }
    })
  )
  return NextResponse.json({ users })
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let email: string
  try {
    const body = await request.json()
    email = body.email?.trim()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!email) return apiError('email は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.inviteUserByEmail(email)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: `${email} に招待メールを送信しました` })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string
  try {
    const body = await request.json()
    userId = body.userId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId) return apiError('userId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: 'ユーザーを削除しました' })
}
```

- [ ] **Step 5: テストが GREEN になることを確認する**

```bash
npm test src/app/api/admin/users/__tests__/route.test.ts
```

期待: 全テスト PASS。

- [ ] **Step 6: admin/user-facilities ルートのテストを書く**

`src/app/api/admin/user-facilities/__tests__/route.test.ts` を以下の内容で作成：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST, DELETE } from '../route'
import { NextRequest } from 'next/server'

const mockInsert = vi.fn()
const mockDelete = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({ from: mockFrom }),
  createServerSupabase: () => ({
    auth: { getUser: mockGetUser },
  }),
}))

const ADMIN_EMAIL = 'admin@test.com'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
  mockGetUser.mockResolvedValue({
    data: { user: { email: ADMIN_EMAIL } },
  })
})

describe('POST /api/admin/user-facilities', () => {
  it('施設を割り当てて 200 を返す', async () => {
    mockFrom.mockReturnValue({ insert: mockInsert })
    mockInsert.mockResolvedValue({ error: null })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInsert).toHaveBeenCalledWith({ user_id: 'u1', facility_id: 'f1' })
  })

  it('非管理者は 403 を返す', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { email: 'other@test.com' } },
    })
    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/admin/user-facilities', () => {
  it('施設割り当てを削除して 200 を返す', async () => {
    const mockEq1 = vi.fn().mockReturnThis()
    const mockEq2 = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ delete: mockDelete })
    mockDelete.mockReturnValue({ eq: mockEq1 })
    mockEq1.mockReturnValue({ eq: mockEq2 })

    const req = new NextRequest('http://localhost/api/admin/user-facilities', {
      method: 'DELETE',
      body: JSON.stringify({ userId: 'u1', facilityId: 'f1' }),
    })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 7: テストが RED になることを確認する**

```bash
npm test src/app/api/admin/user-facilities/__tests__/route.test.ts
```

期待: `Cannot find module '../route'` で FAIL。

- [ ] **Step 8: admin/user-facilities ルートを実装する**

`src/app/api/admin/user-facilities/route.ts` を以下の内容で作成：

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server'
import { apiError } from '@/lib/api-error'

async function requireAdmin() {
  const db = await createServerSupabase()
  const { data: { user } } = await db.auth.getUser()
  const adminEmails = (process.env.ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  const email = user?.email?.trim().toLowerCase() ?? ''
  if (!user || !adminEmails.includes(email)) return null
  return user
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string, facilityId: string
  try {
    const body = await request.json()
    userId = body.userId
    facilityId = body.facilityId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId || !facilityId) return apiError('userId と facilityId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .insert({ user_id: userId, facility_id: facilityId })
  if (error) return apiError(error.message)

  return NextResponse.json({ message: '施設を割り当てました' })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  let userId: string, facilityId: string
  try {
    const body = await request.json()
    userId = body.userId
    facilityId = body.facilityId
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!userId || !facilityId) return apiError('userId と facilityId は必須です', 400)

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .delete()
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
  if (error) return apiError(error.message)

  return NextResponse.json({ message: '施設の割り当てを解除しました' })
}
```

- [ ] **Step 9: 全テストが GREEN になることを確認する**

```bash
npm test src/app/api/admin/
```

期待: 全テスト PASS。

- [ ] **Step 10: コミットする**

```bash
git add src/types/admin.ts \
        src/app/api/admin/users/route.ts \
        src/app/api/admin/users/__tests__/route.test.ts \
        src/app/api/admin/user-facilities/route.ts \
        src/app/api/admin/user-facilities/__tests__/route.test.ts
git commit -m "feat: add admin API routes for user management and facility assignment"
```

---

## Task 4: Admin UI — layout + page + components

**Files:**
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/users/page.tsx`
- Create: `src/components/admin/UserTable.tsx`
- Create: `src/components/admin/InviteModal.tsx`
- Create: `src/components/admin/__tests__/UserTable.test.tsx`
- Create: `src/components/admin/__tests__/InviteModal.test.tsx`

**Interfaces:**
- Consumes:
  - `GET /api/admin/users` → `{ users: AdminUser[] }` （Task 3 で定義）
  - `GET /api/facilities` → `{ facilities: Array<{ id: string, name: string }> }` （既存）
  - `POST/DELETE /api/admin/user-facilities` （Task 3 で定義）
  - `POST /api/admin/users` （Task 3 で定義）
  - `DELETE /api/admin/users` （Task 3 で定義）
- `AdminUser` 型: `{ id: string, email: string, lastSignInAt: string | null, facilityIds: string[] }` （Task 3 で定義）

- [ ] **Step 1: UserTable コンポーネントのテストを書く**

`src/components/admin/__tests__/UserTable.test.tsx` を以下の内容で作成：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UserTable } from '../UserTable'
import type { AdminUser } from '@/types/admin'

const facilities = [
  { id: 'f1', name: '中央病院' },
  { id: 'f2', name: '東クリニック' },
]
const users: AdminUser[] = [
  { id: 'u1', email: 'a@test.com', lastSignInAt: '2026-06-27T00:00:00Z', facilityIds: ['f1'] },
]

describe('UserTable', () => {
  it('ユーザーのメールが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    expect(screen.getByText('a@test.com')).toBeInTheDocument()
  })

  it('展開ボタンをクリックすると施設チェックボックスが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    expect(screen.getByLabelText('中央病院')).toBeInTheDocument()
    expect(screen.getByLabelText('東クリニック')).toBeInTheDocument()
  })

  it('担当施設のチェックボックスは checked になっている', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    expect(screen.getByLabelText('中央病院')).toBeChecked()
    expect(screen.getByLabelText('東クリニック')).not.toBeChecked()
  })

  it('チェックボックスを変更すると onToggleFacility が呼ばれる', () => {
    const onToggle = vi.fn()
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={onToggle}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    fireEvent.click(screen.getByLabelText('東クリニック'))
    expect(onToggle).toHaveBeenCalledWith('u1', 'f2', true)
  })
})
```

- [ ] **Step 2: テストが RED になることを確認する**

```bash
npm test src/components/admin/__tests__/UserTable.test.tsx
```

期待: `Cannot find module '../UserTable'` で FAIL。

- [ ] **Step 3: UserTable コンポーネントを実装する**

`src/components/admin/UserTable.tsx` を以下の内容で作成：

```typescript
'use client'

import React, { useState } from 'react'
import type { AdminUser } from '@/types/admin'

type Facility = { id: string; name: string }

type Props = {
  users: AdminUser[]
  facilities: Facility[]
  onToggleFacility: (userId: string, facilityId: string, add: boolean) => void
  onDeleteUser: (userId: string, email: string) => void
}

export function UserTable({ users, facilities, onToggleFacility, onDeleteUser }: Props) {
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null)

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr style={{ borderBottom: '2px solid #072C2C' }}>
          <th className="text-left py-2 px-3">メール</th>
          <th className="text-left py-2 px-3">最終ログイン</th>
          <th className="text-left py-2 px-3">担当施設</th>
          <th className="py-2 px-3"></th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <React.Fragment key={user.id}>
            <tr style={{ borderBottom: '1px solid #ccc' }}>
              <td className="py-2 px-3">{user.email}</td>
              <td className="py-2 px-3">
                {user.lastSignInAt
                  ? new Date(user.lastSignInAt).toLocaleDateString('ja-JP')
                  : '未ログイン'}
              </td>
              <td className="py-2 px-3">
                <button
                  className="text-xs underline"
                  onClick={() =>
                    setExpandedUserId(expandedUserId === user.id ? null : user.id)
                  }
                >
                  ▼ 展開して設定
                </button>
              </td>
              <td className="py-2 px-3">
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={() => onDeleteUser(user.id, user.email)}
                >
                  削除
                </button>
              </td>
            </tr>
            {expandedUserId === user.id && (
              <tr>
                <td colSpan={4} className="px-6 py-2 bg-white">
                  <div className="flex flex-wrap gap-4">
                    {facilities.map((f) => (
                      <label key={f.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          aria-label={f.name}
                          checked={user.facilityIds.includes(f.id)}
                          onChange={(e) =>
                            onToggleFacility(user.id, f.id, e.target.checked)
                          }
                        />
                        {f.name}
                      </label>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: テストが GREEN になることを確認する**

```bash
npm test src/components/admin/__tests__/UserTable.test.tsx
```

期待: 全テスト PASS。

- [ ] **Step 5: InviteModal コンポーネントのテストを書く**

`src/components/admin/__tests__/InviteModal.test.tsx` を以下の内容で作成：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InviteModal } from '../InviteModal'

describe('InviteModal', () => {
  it('open=false のとき何も表示されない', () => {
    render(<InviteModal open={false} onClose={vi.fn()} onInvite={vi.fn()} />)
    expect(screen.queryByText('ユーザーを招待')).not.toBeInTheDocument()
  })

  it('open=true のときモーダルが表示される', () => {
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={vi.fn()} />)
    expect(screen.getByText('ユーザーを招待')).toBeInTheDocument()
  })

  it('メールを入力して送信すると onInvite が呼ばれる', () => {
    const onInvite = vi.fn()
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={onInvite} />)
    fireEvent.change(screen.getByPlaceholderText('メールアドレス'), {
      target: { value: 'new@test.com' },
    })
    fireEvent.click(screen.getByText('招待する'))
    expect(onInvite).toHaveBeenCalledWith('new@test.com')
  })

  it('メール未入力のとき onInvite は呼ばれない', () => {
    const onInvite = vi.fn()
    render(<InviteModal open={true} onClose={vi.fn()} onInvite={onInvite} />)
    fireEvent.click(screen.getByText('招待する'))
    expect(onInvite).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: テストが RED になることを確認する**

```bash
npm test src/components/admin/__tests__/InviteModal.test.tsx
```

期待: `Cannot find module '../InviteModal'` で FAIL。

- [ ] **Step 7: InviteModal コンポーネントを実装する**

`src/components/admin/InviteModal.tsx` を以下の内容で作成：

```typescript
'use client'

import { useState } from 'react'

type Props = {
  open: boolean
  onClose: () => void
  onInvite: (email: string) => void
}

export function InviteModal({ open, onClose, onInvite }: Props) {
  const [email, setEmail] = useState('')

  if (!open) return null

  const handleSubmit = () => {
    if (!email.trim()) return
    onInvite(email.trim())
    setEmail('')
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-80 shadow-xl">
        <h2 className="text-lg font-semibold mb-4">ユーザーを招待</h2>
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm mb-4"
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm rounded text-white"
            style={{ backgroundColor: '#072C2C' }}
          >
            招待する
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: テストが GREEN になることを確認する**

```bash
npm test src/components/admin/__tests__/InviteModal.test.tsx
```

期待: 全テスト PASS。

- [ ] **Step 9: layout と page を実装する**

`src/app/admin/layout.tsx` を以下の内容で作成：

```typescript
import Link from 'next/link'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div
        className="px-6 py-3 text-sm flex items-center gap-4"
        style={{ backgroundColor: '#072C2C', color: 'white' }}
      >
        <span className="font-semibold">管理画面</span>
        <Link href="/" className="text-white/70 hover:text-white text-xs">
          ← トップに戻る
        </Link>
      </div>
      <div className="max-w-5xl mx-auto px-6 py-8">{children}</div>
    </div>
  )
}
```

`src/app/admin/users/page.tsx` を以下の内容で作成：

```typescript
'use client'

import { useEffect, useState, useCallback } from 'react'
import { UserTable } from '@/components/admin/UserTable'
import { InviteModal } from '@/components/admin/InviteModal'
import type { AdminUser } from '@/types/admin'

type Facility = { id: string; name: string }

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [inviteOpen, setInviteOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const loadUsers = useCallback(async () => {
    const [usersRes, facilitiesRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/facilities'),
    ])
    const { users } = await usersRes.json()
    const { facilities } = await facilitiesRes.json()
    setUsers(users)
    setFacilities(facilities)
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const handleToggleFacility = async (userId: string, facilityId: string, add: boolean) => {
    await fetch('/api/admin/user-facilities', {
      method: add ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, facilityId }),
    })
    setUsers(prev =>
      prev.map(u =>
        u.id !== userId ? u : {
          ...u,
          facilityIds: add
            ? [...u.facilityIds, facilityId]
            : u.facilityIds.filter(id => id !== facilityId),
        }
      )
    )
  }

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!confirm(`${email} を削除しますか？`)) return
    await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    setUsers(prev => prev.filter(u => u.id !== userId))
    showToast('ユーザーを削除しました')
  }

  const handleInvite = async (email: string) => {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    setInviteOpen(false)
    if (res.ok) {
      showToast(`${email} に招待メールを送信しました`)
      await loadUsers()
    } else {
      const { error } = await res.json()
      showToast(`エラー: ${error}`)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">ユーザー管理</h1>
        <button
          onClick={() => setInviteOpen(true)}
          className="px-4 py-2 text-sm text-white rounded"
          style={{ backgroundColor: '#072C2C' }}
        >
          + 招待
        </button>
      </div>

      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={handleToggleFacility}
        onDeleteUser={handleDeleteUser}
      />

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvite={handleInvite}
      />

      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-800 text-white px-4 py-2 rounded shadow text-sm">
          {toast}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 10: 全テストが通ることを確認する**

```bash
npm test
```

期待: 全テスト PASS（既存テストを含む）。

- [ ] **Step 11: コミットする**

```bash
git add src/app/admin/ src/components/admin/
git commit -m "feat: add admin UI for user management and facility assignment"
```

---

## Task 5: 動作確認（完了条件チェック）

**Files:** 変更なし（確認のみ）

- [ ] **Step 1: ローカルアプリを起動する**

```bash
npm run dev
```

- [ ] **Step 2: 担当外施設のデータが見えないことを確認する（ネガティブ確認）**

1. Supabase Studio で `user_facilities` から自分のユーザーの行を一つ削除する（例: 施設Bの行を削除）
2. ブラウザで施設Bの詳細ページにアクセス → データが表示されないことを確認
3. 削除した行を `user_facilities` に戻す

- [ ] **Step 3: 管理画面でユーザーを招待できることを確認する**

1. `http://localhost:3000/admin/users` にアクセス
2. 「+ 招待」ボタンをクリック
3. メールアドレスを入力して「招待する」→ 成功トーストが表示される

- [ ] **Step 4: 施設の割り当てが機能することを確認する**

1. ユーザー行の「▼ 展開して設定」をクリック
2. 施設チェックボックスをオン/オフ → `user_facilities` の行がリアルタイムに変わることをSupabase Studioで確認

- [ ] **Step 5: 共有データが引き続き全ユーザーに見えることを確認する**

`/products`、`/distributor-products`、`/categories` にアクセス → 正常にデータが表示される。

- [ ] **Step 6: npm test と npm run lint を通す**

```bash
npm test && npm run lint
```

期待: 全 PASS / エラーなし。

- [ ] **Step 7: 最終コミット**

```bash
git add -A
git commit -m "chore: Phase 2 multi-tenant implementation complete"
```
