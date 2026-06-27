# Phase 1: Magic Linkログイン実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Magic Link認証を導入し、未認証アクセスをブロック。`service_role_key` → SSRセッションクライアントへ切替でRLSを有効化する。

**Architecture:** `@supabase/ssr` の `createServerClient` をファクトリ関数として提供し、全repositoryがDI引数（`db`）でクライアントを受け取る。middlewareが全リクエストのセッション更新と認証ガードを担当する。

**Tech Stack:** Next.js 16 App Router, `@supabase/ssr@^0.12.0`, `@supabase/supabase-js@^2.108`, Playwright, Vitest

## Global Constraints

- `@supabase/ssr` の `createServerClient` のみを使用（`createClient` はadmin用途に限定）
- `cookies()` は Next.js 16 では async のため `await cookies()` が必要
- repository 関数はすべて第1引数に `db: SupabaseClient` を受け取る形に統一
- `SUPABASE_SERVICE_ROLE_KEY` はサーバーサイドのみで使用（`NEXT_PUBLIC_` プレフィックスをつけない）
- Phase 2（マルチテナント）は別計画。本計画はRLS有効化と認証のみ

---

## ファイル構成

| ファイル | 種別 | 責務 |
|---|---|---|
| `src/lib/supabase/server.ts` | 変更 | `createServerSupabase()`・`createAdminSupabase()` のファクトリ関数 |
| `src/lib/supabase/client.ts` | 新規 | ブラウザ用クライアント（Client Component から使用） |
| `src/lib/*/repository.ts` × 12 | 変更 | `db` パラメータを追加（DI化） |
| `src/lib/price-histories/__tests__/repository.test.ts` | 変更 | モジュールmock → DI引数でモック渡しに変更 |
| `src/app/api/*/route.ts` × 16 | 変更 | `await createServerSupabase()` でクライアント生成・repository に渡す |
| `src/middleware.ts` | 変更 | updateSession + 認証ガード + admin ガード |
| `src/app/login/page.tsx` | 新規 | Magic Link送信フォーム（Client Component） |
| `src/app/auth/callback/route.ts` | 新規 | PKCEコード交換・セッション確立 |
| `e2e/global-setup.ts` | 新規 | Admin APIでテストユーザーセッション発行・storageState保存 |
| `e2e/smoke.spec.ts` | 変更 | storageState使用の認証済みテストに更新 |
| `playwright.config.ts` | 変更 | globalSetup + storageState設定を追加 |

---

## Task 1: server.ts のDI化 + client.ts 新規作成

**Files:**
- Modify: `src/lib/supabase/server.ts`
- Create: `src/lib/supabase/client.ts`

**Interfaces:**
- Produces: `createServerSupabase(): Promise<SupabaseClient>` — Route Handlers と middleware が使用
- Produces: `createAdminSupabase(): SupabaseClient` — admin APIルートが使用（service_role_key）
- Produces: `createBrowserClient()` — Client Components が使用

- [ ] **Step 1: 環境変数を `.env.local` に追加**

`.env.local` に以下を追記（`NEXT_PUBLIC_SUPABASE_ANON_KEY` は Supabase Dashboard → Settings → API → anon public から取得）:

```
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase Dashboardから取得>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
ADMIN_EMAILS=<管理者のメールアドレス>
```

- [ ] **Step 2: `src/lib/supabase/server.ts` を書き換える**

```typescript
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createServerSupabase() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Components は cookies を書けない。middleware が token refresh を担当する。
          }
        },
      },
    }
  )
}

export function createAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
```

- [ ] **Step 3: `src/lib/supabase/client.ts` を新規作成**

```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
```

- [ ] **Step 4: TypeScriptビルドエラーがないことを確認**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし（または server.ts の `supabase` export が消えたことによるエラーのみ、Task 2-3 で解消する）

- [ ] **Step 5: コミット**

```bash
git add src/lib/supabase/server.ts src/lib/supabase/client.ts
git commit -m "refactor: server.ts を DI ファクトリ関数に変更、client.ts 追加"
```

---

## Task 2: repository 12ファイルの DI 化

**Files:**
- Modify: `src/lib/facilities/repository.ts`
- Modify: `src/lib/products/repository.ts`
- Modify: `src/lib/distributor-products/repository.ts`
- Modify: `src/lib/hospital-prices/repository.ts`
- Modify: `src/lib/categories/repository.ts`
- Modify: `src/lib/consumables/repository.ts`
- Modify: `src/lib/case-orders/repository.ts`
- Modify: `src/lib/loan-orders/repository.ts`
- Modify: `src/lib/loan-returns/repository.ts`
- Modify: `src/lib/consumable-orders/repository.ts`
- Modify: `src/lib/price-histories/repository.ts`
- Modify: `src/lib/price-histories/__tests__/repository.test.ts`

**Interfaces:**
- Consumes: なし（singleton import を削除）
- Produces: 全 repository 関数が第1引数に `db: SupabaseClient` を受け取る

- [ ] **Step 1: `facilities/repository.ts` でパターンを確立**

`import { supabase } from '@/lib/supabase/server'` 行を削除し、各関数の第1引数に `db` を追加する。

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import { asString } from '@/lib/mapping'
import type { Facility, FacilityInput } from '@/types/facility'

const FACILITY_COLUMNS = 'id, name, created_at, updated_at'

interface FacilityRow {
  id?: unknown
  name?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapFacility(row: FacilityRow): Facility {
  return {
    id: asString(row.id),
    name: asString(row.name),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listFacilities(db: SupabaseClient): Promise<Facility[]> {
  const { data, error } = await db
    .from('facilities')
    .select(FACILITY_COLUMNS)
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapFacility)
}

export async function getFacility(db: SupabaseClient, id: string): Promise<Facility | null> {
  const { data, error } = await db
    .from('facilities')
    .select(FACILITY_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function createFacility(db: SupabaseClient, input: FacilityInput): Promise<Facility> {
  const { data, error } = await db
    .from('facilities')
    .insert({ name: input.name })
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function updateFacility(db: SupabaseClient, id: string, input: FacilityInput): Promise<Facility> {
  const { data, error } = await db
    .from('facilities')
    .update({ name: input.name })
    .eq('id', id)
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`施設ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function deleteFacility(db: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await db
    .from('facilities')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`施設ID "${id}" は存在しません`)
}
```

- [ ] **Step 2: 残り 11 repository ファイルに同じパターンを適用**

以下の変換ルールを各ファイルに機械的に適用する:
1. `import { supabase } from '@/lib/supabase/server'` を削除
2. `import type { SupabaseClient } from '@supabase/supabase-js'` を追加
3. 各 `export async function xxx(...)` の第1引数に `db: SupabaseClient` を追加
4. 関数内の `supabase.from(...)` / `supabase.rpc(...)` を `db.from(...)` / `db.rpc(...)` に置換

対象ファイル:
- `src/lib/products/repository.ts`
- `src/lib/distributor-products/repository.ts`
- `src/lib/hospital-prices/repository.ts`
- `src/lib/categories/repository.ts`
- `src/lib/consumables/repository.ts`
- `src/lib/case-orders/repository.ts`
- `src/lib/loan-orders/repository.ts`
- `src/lib/loan-returns/repository.ts`
- `src/lib/consumable-orders/repository.ts`
- `src/lib/price-histories/repository.ts`

確認コマンド（変換漏れチェック）:
```bash
grep -rn "import.*supabase.*from.*lib/supabase/server" src/lib/
```
Expected: 出力なし（全 import が削除されている）

- [ ] **Step 3: `price-histories/__tests__/repository.test.ts` をDI形式に更新**

モジュールモック方式を廃止し、DI引数で渡すクリーンな形に変更する:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPriceHistory } from '../repository'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMockDb(rpcResult: unknown): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValueOnce(rpcResult) } as unknown as SupabaseClient
}

describe('getPriceHistory', () => {
  it('should map RPC response with dist_product_id correctly', async () => {
    const mockData = [
      {
        id: 'hist-1',
        entity_type: 'distributor_product',
        entity_id: 'dp-1',
        dist_product_id: 'dpi-123',
        field_name: 'reimbursement_price',
        old_value: 100,
        new_value: 110,
        changed_at: '2026-06-22T10:00:00Z',
        facility_name: null,
      },
      {
        id: 'hist-2',
        entity_type: 'hospital_price',
        entity_id: 'hp-1',
        dist_product_id: 'dpi-123',
        field_name: 'purchase_price',
        old_value: 80,
        new_value: 85,
        changed_at: '2026-06-22T11:00:00Z',
        facility_name: '病院A',
      },
    ]
    const db = makeMockDb({ data: mockData, error: null })
    const result = await getPriceHistory(db, 'dpi-123')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: 'hist-1',
      entityType: 'distributor_product',
      entityId: 'dp-1',
      distributorProductId: 'dpi-123',
      fieldName: 'reimbursement_price',
      oldValue: 100,
      newValue: 110,
      changedAt: '2026-06-22T10:00:00Z',
      facilityName: null,
    })
    expect(result[1].facilityName).toBe('病院A')
    expect((db.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'get_distributor_product_price_history',
      { p_distributor_product_id: 'dpi-123' }
    )
  })

  it('should handle null values in old_value and new_value', async () => {
    const mockData = [
      {
        id: 'hist-3',
        entity_type: 'distributor_product',
        entity_id: 'dp-2',
        dist_product_id: 'dpi-456',
        field_name: 'delivery_price',
        old_value: null,
        new_value: 50,
        changed_at: '2026-06-22T12:00:00Z',
        facility_name: null,
      },
    ]
    const db = makeMockDb({ data: mockData, error: null })
    const result = await getPriceHistory(db, 'dpi-456')

    expect(result[0].oldValue).toBeNull()
    expect(result[0].newValue).toBe(50)
  })

  it('should throw error when RPC fails', async () => {
    const db = makeMockDb({ data: null, error: { message: 'Database error' } })
    await expect(getPriceHistory(db, 'dpi-789')).rejects.toThrow('Database error')
  })

  it('should return empty array when no records found', async () => {
    const db = makeMockDb({ data: [], error: null })
    const result = await getPriceHistory(db, 'dpi-nonexistent')
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 4: テストを実行して PASS を確認**

```bash
npm test src/lib/price-histories/__tests__/repository.test.ts
```

Expected: 4件 PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/
git commit -m "refactor: repository 全12ファイルを DI 化（supabase singleton → db 引数）"
```

---

## Task 3: route.ts 全16ファイルの更新

**Files:**
- Modify: `src/app/api/facilities/route.ts`
- Modify: `src/app/api/facilities/[id]/route.ts`
- Modify: `src/app/api/products/route.ts`
- Modify: `src/app/api/products/[id]/route.ts`
- Modify: `src/app/api/distributor-products/route.ts`
- Modify: `src/app/api/distributor-products/[id]/route.ts`
- Modify: `src/app/api/distributor-products/[id]/price-history/route.ts`
- Modify: `src/app/api/hospital-prices/route.ts`
- Modify: `src/app/api/hospital-prices/[id]/route.ts`
- Modify: `src/app/api/categories/route.ts`
- Modify: `src/app/api/categories/[id]/route.ts`
- Modify: `src/app/api/consumables/route.ts`
- Modify: `src/app/api/case-orders/route.ts`
- Modify: `src/app/api/loan-orders/route.ts`
- Modify: `src/app/api/loan-returns/route.ts`
- Modify: `src/app/api/consumable-orders/route.ts`

**Interfaces:**
- Consumes: `createServerSupabase(): Promise<SupabaseClient>` from Task 1
- Consumes: repository 関数の `db` 第1引数 from Task 2

- [ ] **Step 1: `facilities/route.ts` でパターンを確立**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import { apiError } from '@/lib/api-error'
import type { FacilityInput } from '@/types/facility'

export async function GET() {
  try {
    const db = await createServerSupabase()
    const facilities = await listFacilities(db)
    return NextResponse.json({ facilities, data: facilities })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '施設の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.name?.trim()) {
    return apiError('施設名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    const facility = await createFacility(db, input)
    return NextResponse.json({ facility, data: facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('施設名が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '施設の作成に失敗しました')
  }
}
```

- [ ] **Step 2: 残り 15 route.ts ファイルに同じパターンを適用**

変換ルール:
1. repository import はそのまま（ファイル名のみ変更なし）
2. `createServerSupabase` を import に追加
3. 各ハンドラ関数内の try ブロック先頭に `const db = await createServerSupabase()` を追加
4. repository 関数呼び出しの第1引数に `db` を追加

- [ ] **Step 3: TypeScript ビルドエラーがないことを確認**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし

- [ ] **Step 4: 開発サーバーを起動してAPIが動作することを確認**

```bash
npm run dev
```

別ターミナルで:
```bash
curl http://localhost:3000/api/facilities
```

Expected: `{"facilities":[...],"data":[...]}` が返る（まだ認証なしで通る）

- [ ] **Step 5: コミット**

```bash
git add src/app/api/
git commit -m "refactor: route.ts 全16ファイルを createServerSupabase DI パターンに更新"
```

---

## Task 4: middleware の認証実装

**Files:**
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ADMIN_EMAILS` 環境変数
- Produces: 認証ガード（未認証→`/login`）、adminガード（`/admin/*`, `/api/admin/*`）、updateSession

- [ ] **Step 1: middleware.ts を書き換える**

```typescript
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/auth/callback']

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // トークンリフレッシュ（updateSession パターン）
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // 未認証ガード
  if (!user && !PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // admin ガード（middleware + 各 route で二重チェック）
  const isAdminPath = pathname.startsWith('/admin') || pathname.startsWith('/api/admin')
  if (isAdminPath) {
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
    const userEmail = user?.email?.trim().toLowerCase() ?? ''
    if (!user || !adminEmails.includes(userEmail)) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

- [ ] **Step 2: 未認証リダイレクトを手動確認**

開発サーバーが起動していない場合は起動:
```bash
npm run dev
```

ブラウザで `http://localhost:3000/facilities` にアクセス。
Expected: `/login` にリダイレクトされる（ログインページは次のタスクで作成するため404になるが、リダイレクト自体は確認できる）

- [ ] **Step 3: コミット**

```bash
git add src/middleware.ts
git commit -m "feat: middleware に認証ガードと admin ガードを実装"
```

---

## Task 5: ログインページ + auth/callback

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/app/auth/callback/route.ts`

**Interfaces:**
- Consumes: `createSupabaseBrowserClient()` from Task 1（client.ts）
- Consumes: `NEXT_PUBLIC_SITE_URL` 環境変数
- Produces: Magic Link送信 → `/auth/callback` → セッション確立 → `/` リダイレクト

- [ ] **Step 1: `src/app/login/page.tsx` を作成**

```typescript
'use client'

import { useState, FormEvent } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const urlError = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('error')
    : null

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
      },
    })

    setLoading(false)
    if (signInError) {
      setError('メールの送信に失敗しました。メールアドレスを確認してください。')
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }}>
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold mb-4" style={{ color: '#072C2C' }}>
            メールを送信しました
          </h1>
          <p className="text-gray-600">
            <strong>{email}</strong> にログインリンクを送信しました。<br />
            メールを確認してリンクをクリックしてください。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#EDEADE' }}>
      <div className="bg-white rounded-lg shadow p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-6 text-center" style={{ color: '#072C2C' }}>
          Medical Inventory
        </h1>
        {(urlError || error) && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error ?? '認証に失敗しました。もう一度お試しください。'}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
              placeholder="example@example.com"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 rounded text-white text-sm font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#072C2C' }}
          >
            {loading ? '送信中...' : 'ログインリンクを送信'}
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `src/app/auth/callback/route.ts` を作成**

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=auth', request.url))
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(new URL('/login?error=auth', request.url))
  }

  return NextResponse.redirect(new URL('/', request.url))
}
```

- [ ] **Step 3: SupabaseDashboard で Magic Link（OTP）設定を確認**

Supabase Dashboard → Authentication → Providers → Email:
- "Enable Email Signup" が有効
- "Confirm email" が有効（Magic Link は OTP として送信される）

Supabase Dashboard → Authentication → URL Configuration:
- Site URL: `http://localhost:3000`（開発）
- Redirect URLs に `http://localhost:3000/auth/callback` を追加

- [ ] **Step 4: ブラウザでMagic Linkログインを手動確認**

1. `http://localhost:3000/login` にアクセス
2. メールアドレスを入力して送信
3. 「メールを送信しました」画面が表示される
4. メールのリンクをクリック
5. `/auth/callback` でセッション確立後、`/` にリダイレクトされる
6. ログイン後、全ナビページ（施設・デバイス・販売店商品・ニュース・コンパチ・その他）でデータが正常に表示される
7. DevTools Network タブで API が 401/403/500 を返していないことを確認

- [ ] **Step 5: コミット**

```bash
git add src/app/login/page.tsx src/app/auth/callback/route.ts
git commit -m "feat: Magic Link ログインページと auth/callback を実装"
```

---

## Task 6: E2Eテストの認証対応

**Files:**
- Create: `e2e/global-setup.ts`
- Create: `e2e/.auth/.gitkeep`
- Modify: `playwright.config.ts`
- Modify: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `E2E_TEST_EMAIL` 環境変数
- Produces: `e2e/.auth/user.json`（storageState）— smoke.spec.ts が使用

- [ ] **Step 1: `.env.local` に E2E テスト用変数を追加**

```
E2E_TEST_EMAIL=<Supabase Authに登録済みのテスト用メールアドレス>
```

Supabase Dashboard → Authentication → Users でテストユーザーを事前に作成しておく（メールアドレスのみで可）。

- [ ] **Step 2: `e2e/global-setup.ts` を作成**

```typescript
import { createClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

async function globalSetup() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const testEmail = process.env.E2E_TEST_EMAIL

  if (!supabaseUrl || !serviceRoleKey || !testEmail) {
    throw new Error('E2E: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / E2E_TEST_EMAIL が未設定')
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Admin API でマジックリンクを直接生成（メール送信不要）
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: testEmail,
  })

  if (error || !data.properties?.action_link) {
    throw new Error(`テストセッション生成失敗: ${error?.message}`)
  }

  // ブラウザでリンクを開いてセッションCookieを取得
  const authDir = path.join(process.cwd(), 'e2e', '.auth')
  fs.mkdirSync(authDir, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(data.properties.action_link)
  await page.waitForURL('/')
  await page.context().storageState({ path: path.join(authDir, 'user.json') })
  await browser.close()
}

export default globalSetup
```

- [ ] **Step 3: `e2e/.auth/.gitkeep` を作成してディレクトリをgit管理**

```bash
mkdir -p e2e/.auth
touch e2e/.auth/.gitkeep
```

`.gitignore` に以下を追加（セッションファイルはコミットしない）:
```
e2e/.auth/user.json
```

- [ ] **Step 4: `playwright.config.ts` を更新**

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3000',
    storageState: 'e2e/.auth/user.json',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
```

- [ ] **Step 5: `e2e/smoke.spec.ts` を確認し、必要なら `/login` リダイレクトテストを追加**

既存の smoke.spec.ts は認証済み状態（storageState）で実行されるため、基本的な変更は不要。
ただし未認証リダイレクトの確認テストを追加する:

```typescript
// smoke.spec.ts の末尾に追加
test('未認証でアクセスすると /login にリダイレクトされる', async ({ browser }) => {
  // storageState を使わない新しいコンテキストで確認
  const context = await browser.newContext() // storageState なし
  const page = await context.newPage()
  await page.goto('/facilities')
  await expect(page).toHaveURL(/\/login/)
  await context.close()
})
```

- [ ] **Step 6: E2E テストを実行**

```bash
npx playwright test --reporter=list
```

Expected: 全テスト PASS（既存7ケース + 未認証リダイレクト1ケース）

- [ ] **Step 7: コミット**

```bash
git add e2e/global-setup.ts e2e/.auth/.gitkeep e2e/smoke.spec.ts playwright.config.ts .gitignore
git commit -m "test: E2E スモークテストに Magic Link 認証セットアップを追加"
```

---

## Task 7: 統合動作確認

**Files:** なし（確認のみ）

- [ ] **Step 1: 本番ビルドが成功することを確認**

```bash
npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`（エラーなし）

- [ ] **Step 2: 全ナビページの動作確認（ログイン後）**

開発サーバーで以下を順番に開いてデータが表示されることを確認:
- `http://localhost:3000/facilities` — 施設一覧
- `http://localhost:3000/products` — デバイス一覧
- `http://localhost:3000/distributor-products` — 販売店商品一覧
- `http://localhost:3000/hospital-prices` — 病院価格（施設選択後）
- 注文画面（case-orders / loan-orders / consumable-orders）

DevTools → Network タブで各 `/api/*` リクエストが 200 を返すことを確認。

- [ ] **Step 3: 主要書き込み操作の確認**

- 施設の新規作成
- 価格の更新
- 消耗品の登録

Expected: 正常に保存され、一覧に反映される。

- [ ] **Step 4: セッション有効期限の確認**

Supabase Dashboard → Authentication → Settings で JWT expiry を短く（例: 60秒）に変更し、60秒後に操作しても401が出ないことを確認。確認後 JWT expiry を元の値（3600秒等）に戻す。

- [ ] **Step 5: 最終コミット（変更があれば）**

```bash
git add -p  # 変更内容を確認してから追加
git commit -m "chore: Phase 1 統合動作確認・細部修正"
```

---

## Phase 2 について

マルチテナント（`user_facilities` テーブル + RLS書き換え + 注文RPCチェック + 管理画面）は別の実装計画 `2026-06-27-phase2-multitenant.md` として作成する。Phase 1の全完了条件が満たされてから着手すること。
