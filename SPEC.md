# SPEC: /products・/distributor-products への検索・絞り込みUI追加（issue #483 6-pairフレームワーク2本目）

## Part 1 — 仕様（★人間がレビューする部分）

### 何ができるようになるか（利用者目線）

#### /products（デバイス一覧）
- テキスト入力でキーワード検索できる（製品名・メーカー名・JANコード・REFコードを対象）
- クリアボタンで検索条件をリセットできる
- URLにクエリパラメータが反映され、ブラウザバック・リロードで状態が復元される

#### /distributor-products（販売店商品一覧）
- テキスト入力でキーワード検索できる（商品名・メーカー名・仕入先を対象）
- カテゴリセレクトボックスで絞り込みができる
- キーワード・カテゴリを組み合わせて絞り込みできる（AND）
- クリアボタンで全条件リセット
- URLにクエリパラメータが反映される

#### 共通
- キーワード入力はデバウンス（300ms）でリクエスト最小化
- 再検索中は**前回の結果を表示したまま**薄いローディング表示を重ねる（結果を消さない）
- 検索結果0件の場合は「該当する○○がありません」を表示（products/distributor-productsで文言を分ける）
- fetch失敗時は既存リストを保持したままエラーバナーを表示する（自動リトライは今回スコープ外）
- 新規検索まわりのエラー表示は `role="alert"` 付き `bg-red-50 text-red-700` スタイルに統一する（distributor-products/page.tsx の既存スタイルに合わせる。products/page.tsx側の既存インラインスタイルとは新規分に限り統一しない＝ページ内スタイル混在は許容）

### 重要な既存実装の発見（調査で確定した事実）

`src/lib/compatibilities/repository.ts:110-146` に、本仕様が必要とする「LIKEエスケープ + PostgREST `.or()` 複合検索」の**実証済み実装**が既に存在する。
- `buildIlikeValue(keyword)`（L110-116）が `%` `_` `\` `"` をエスケープし、PostgRESTの`.or()`予約文字（`,` `(` `)`）に対応するため値全体をダブルクォートで囲む
- `query.or([...].join(','))` + `.eq('category_id', ...)` + `.order('created_at', {ascending:false})` が1クエリで共存し、テスト（`__tests__/repository.test.ts`）も存在

→ 本仕様はこの`buildIlikeValue`を**新規実装せず共有関数として抽出・流用する**。自前でLIKEエスケープを書き直さないこと。

### 受け入れ条件（チェックリスト）

#### /products
- [ ] キーワードを入力すると300ms後にAPIリクエストが発火し、一覧が絞り込まれる
- [ ] キーワード検索はname・maker・jan・refのOR一致（ILIKE、`buildIlikeValue`でエスケープ済み）で動作する
- [ ] 空文字列・未入力時は全件を返す（`?keyword=`パラメータ自体を省略する。既に`?keyword=`で来た場合も空扱い）
- [ ] URLパラメータ`?keyword=xxx`に状態が同期され、リロード後も検索条件が維持される
- [ ] クリアボタンでkeywordがリセットされ、URLパラメータも消える
- [ ] `keyword`の長さ上限は100文字。超過時はAPIが400を返しエラーメッセージを表示する（フロント側も`maxLength`属性で入力を制限する）
- [ ] 認証必須（未認証時は既存の401動作を維持）

#### /distributor-products
- [ ] キーワード検索はname・maker・supplierのOR一致（ILIKE、`buildIlikeValue`でエスケープ済み）で動作する
- [ ] カテゴリセレクタでは全カテゴリが選択肢として表示される（ラベル「すべてのカテゴリ」をデフォルト、value=""）
- [ ] カテゴリを選択するとcategory_idで完全一致フィルタが適用される（存在しないUUIDを指定した場合は0件を返す。存在確認の事前チェックは行わない）
- [ ] キーワードとカテゴリのAND絞り込みが機能する
- [ ] URLパラメータ`?keyword=xxx&categoryId=uuid`に状態が同期される
- [ ] クリアボタンで全条件リセット・URLパラメータも消える
- [ ] `keyword`の長さ上限は100文字。超過時APIが400を返しエラー表示
- [ ] `categoryId`はUUID形式（v4）バリデーション（不正値は400）

#### 境界条件（DBスキーマ・認可非変更の確認）
- [ ] products・distributor_products・categoriesテーブルの列定義・外部キー・RLSポリシーは変更しない
- [ ] 今回はインデックス追加も行わない（下記「今回やらないこと」参照）
- [ ] facility/tenant非依存マスタ扱いを変更しない（RLS追加不要）
- [ ] admin以外でもGETで検索できる（既存権限と同様。根拠: `supabase/migrations/20260629000001_fix_master_rls.sql`の`products_select`・`distributor_products_select`ポリシーが`FOR SELECT TO authenticated USING (true)`）

### 今回やらないこと（スコープ外・意図的な見送り）

- **検索用DBインデックス追加**: `ILIKE '%keyword%'`（前後ワイルドカード）はB-treeインデックスで高速化されない。今インデックスを追加してもマイグレーションリスクが増えるだけで性能改善はゼロ。本番で実測して遅ければ`pg_trgm`+GINインデックスへの移行を別issueで検討する
- **categoryIdの実在確認**: UUID形式チェックのみ行い、DB側の実在チェック（追加のround trip）は行わない。存在しないUUIDは自然に0件が返る
- **E2Eテスト（Playwright）**: 「URLリロード後に状態復元」はユニットテストでは検証できずE2Eが必要だが、今回のスコープには含めない。必要なら別issue化する
- **レスポンスキー名の統一**: `/api/products`は`{products}`、`/api/distributor-products`は`{items}`のまま。既存クライアントとの互換性維持のため意図的に統一しない
- **products/page.tsx側の既存エラースタイルの統一**: 新規追加分のみ`role="alert"`スタイルに統一し、既存のインラインスタイルバナーはそのまま残す

### 人間の決定事項（2026-07-21 停止①レビューで確定）

1. **Enterキーでの即時検索 → 追加しない。** デバウンス（300ms）のみとする。理由: 1本目（施設セレクタUI）と規模感を揃えるのが本検証の目的であり、UX上位の追加機能はスコープを広げるだけのため
2. **`buildIlikeValue`の共有化 → `compatibilities/repository.ts`も含めて共有関数化する（Yes）。** 理由: 発見されたcritical指摘（LIKEワイルドカードのエスケープ漏れ）は実際のセキュリティ上の穴であり、自前で書き直すより実証済みの実装を再利用する方が確実。回帰テスト範囲が広がるコストは「正しさを広げる」ものとして許容する

### 操作の流れ

1. ユーザーが`/products`または`/distributor-products`を開く
2. キーワード入力欄に入力 → 300ms後に自動で絞り込まれる（前回結果は消さず薄いローディング表示）
3. （distributor-productsのみ）カテゴリセレクタで絞り込みを追加
4. クリアボタンで全条件リセット
5. URLはこれらの状態と常に同期し、リロード・ブラウザバックで復元される

📸 スクリーンショット対象: `/products`・`/distributor-products`（検索前後の状態、クリア後の状態）

---

## Part 2 — 実装計画（AI用）

### 実装セット一覧（依存順）

```
Set A: 共有ヘルパー新設（LIKEエスケープ + キーワードクエリパーサ + DBエラーサニタイズ）
Set B: 型定義拡張（types/product.ts, types/distributorProduct.ts）
Set C: Repository層フィルタ追加（lib/products/repository.ts, lib/distributor-products/repository.ts, lib/compatibilities/repository.tsの差し替え）
Set D: API Route拡張（api/products/route.ts, api/distributor-products/route.ts）+ 既存テスト修正
Set E-1: 検索フォームコンポーネント新規作成（components/products/ProductSearchFilters.tsx）
Set E-2: 検索フォームコンポーネント新規作成（components/distributor-products/DistributorProductSearchFilters.tsx）
Set F-1: /products/page.tsx 統合
Set F-2: /distributor-products/page.tsx 統合
```

依存グラフ:
- AはB・Cに先行（共有ヘルパーが先）
- CはDに先行
- DはF-1/F-2に先行
- E-1/E-2はDと並列可（インタフェース合意後）
- F-1/F-2はD・E-1/E-2完了後

**旧ドラフトからの変更点**: 旧「Set A: DBマイグレーション（インデックス追加）」は削除（今回やらないこと参照）。新Set Aは共有ヘルパー新設に差し替え。

---

### 各セットの詳細

#### Set A: 共有ヘルパー新設

**ファイル**: `src/lib/search/like-pattern.ts`（新規）

`src/lib/compatibilities/repository.ts:110-116`の`buildIlikeValue`をこのファイルに抽出し、`compatibilities/repository.ts`側はこの共有関数をimportして使うよう差し替える。実装内容は既存のものをそのまま移設する（新規に書き直さない）。

**ファイル**: `src/lib/api-keyword-query.ts`（新規）

`src/lib/api-pagination.ts`の`parsePagination`と対称な設計で実装する:
```typescript
export type KeywordQueryResult =
  | { ok: true; keyword?: string }
  | { ok: false; response: NextResponse }

export function parseKeyword(
  params: URLSearchParams,
  opts?: { maxLength?: number }
): KeywordQueryResult {
  const maxLength = opts?.maxLength ?? 100
  const raw = params.get('keyword') ?? ''
  if (raw.length > maxLength) {
    return { ok: false, response: apiError(`keyword は ${maxLength} 文字以内で指定してください`, 400) }
  }
  const keyword = raw.trim() || undefined
  return { ok: true, keyword }
}
```

**ファイル**: `src/lib/api-error.ts`（既存ファイルに追加）

```typescript
// WHY: Supabase/Postgresの生エラーメッセージにはテーブル名・制約名が含まれうるため、
//      クライアントに返す前に必ずこの関数を通してスキーマ情報の漏洩を防ぐ
export function sanitizeDbError(error: unknown, fallbackMessage: string): string {
  // 23505(unique_violation)・23503(foreign_key_violation)等、既存の個別コードハンドリングがあれば維持する。
  // それ以外は生メッセージを返さずfallbackMessageのみ返す。詳細はconsole.errorでサーバ側ログにのみ記録する。
  console.error(error)
  return fallbackMessage
}
```

**テスト観点**:
- `like-pattern.test.ts`: `%`・`_`・`\`・`"`・`,`・`(`・`)`を含むキーワードが正しくエスケープされる（既存`compatibilities/repository.test.ts`のテストケースを移設・再利用）
- `api-keyword-query.test.ts`: 101文字でng、100文字以内でok、空文字列で`keyword: undefined`
- `sanitizeDbError`: どんなErrorを渡してもfallbackMessageのみが返り、元のmessageが含まれない

---

#### Set B: 型定義拡張

**ファイル**: `src/types/product.ts`

```typescript
export type ProductsApiQuery = { keyword?: string }
export type ProductsApiResponse = { products: Product[] }
export type ProductsApiErrorResponse = { error: string }
```

**ファイル**: `src/types/distributorProduct.ts`

```typescript
export type DistributorProductsApiQuery = { keyword?: string; categoryId?: string }
export type DistributorProductsApiResponse = { items: DistributorProduct[] }
export type DistributorProductsApiErrorResponse = { error: string }
```

参照実装: `src/types/order.ts:198-218`（OrdersApiQuery/Response/ErrorResponse）

**テスト観点**: 型定義のみ。ランタイムテスト不要

---

#### Set C: Repository層フィルタ追加

**ファイル**: `src/lib/products/repository.ts`

```typescript
import { buildIlikeValue } from '@/lib/search/like-pattern'

export type ProductListFilter = { keyword?: string }

export async function listProducts(
  db: SupabaseClient,
  filter?: ProductListFilter
): Promise<Product[]> {
  let query = db.from('products').select(PRODUCT_COLUMNS).order('created_at', { ascending: false })

  if (filter?.keyword) {
    const value = buildIlikeValue(filter.keyword)
    query = query.or([`name.ilike.${value}`, `maker.ilike.${value}`, `jan.ilike.${value}`, `ref.ilike.${value}`].join(','))
  }

  const { data, error } = await query
  if (error) throw error // sanitizeDbErrorはroute.ts側で通す。ここでは生のerrorをそのままthrowする
  return data.map(mapProduct)
}
```

注: フィルタなしの呼び出し（既存コード）は後方互換を保つ（引数オプショナル）。

**ファイル**: `src/lib/distributor-products/repository.ts`

```typescript
import { buildIlikeValue } from '@/lib/search/like-pattern'

export type DistributorProductListFilter = { keyword?: string; categoryId?: string }

export async function listDistributorProducts(
  db: SupabaseClient,
  filter?: DistributorProductListFilter
): Promise<DistributorProduct[]> {
  let query = db.from('distributor_products').select(DISTRIBUTOR_PRODUCT_COLUMNS).order('created_at', { ascending: false })

  if (filter?.keyword) {
    const value = buildIlikeValue(filter.keyword)
    query = query.or([`name.ilike.${value}`, `maker.ilike.${value}`, `supplier.ilike.${value}`].join(','))
  }
  if (filter?.categoryId) {
    query = query.eq('category_id', filter.categoryId)
  }

  const { data, error } = await query
  if (error) throw error
  return data.map(mapDistributorProduct)
}
```

**ファイル**: `src/lib/compatibilities/repository.ts`

`buildIlikeValue`のローカル定義を削除し、`src/lib/search/like-pattern.ts`からimportするよう差し替える（振る舞いは変えない、単なる抽出）。

**テスト観点** (`src/lib/products/__tests__/repository.test.ts` 等):
- keywordなし → 全件返却
- keywordあり → name/maker/jan/refのいずれかに含む行のみ返却
- keywordが大文字小文字を区別しない
- keywordに`%`・`_`・`,`が含まれても正しくエスケープされて検索される（誤動作しない）
- distributor-products: categoryIdフィルタ単体
- distributor-products: keyword + categoryIdのAND絞り込み
- 空結果（0件）が正常に返る
- `compatibilities/repository.test.ts`が差し替え後も全件パスする（回帰確認）

---

#### Set D: API Route拡張

**ファイル**: `src/app/api/products/route.ts`

```typescript
import { parseKeyword } from '@/lib/api-keyword-query'
import { sanitizeDbError } from '@/lib/api-error'

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }

    const kw = parseKeyword(request.nextUrl.searchParams)
    if (!kw.ok) return kw.response

    const products = await listProducts(db, { keyword: kw.keyword })
    return NextResponse.json({ products } satisfies ProductsApiResponse)
  } catch (error) {
    return apiError(sanitizeDbError(error, '製品の取得に失敗しました'))
  }
}
```

**ファイル**: `src/app/api/distributor-products/route.ts`

```typescript
import { parseKeyword } from '@/lib/api-keyword-query'
import { sanitizeDbError } from '@/lib/api-error'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }

    const params = request.nextUrl.searchParams
    const kw = parseKeyword(params)
    if (!kw.ok) return kw.response

    const rawCategoryId = params.get('categoryId') ?? ''
    if (rawCategoryId && !UUID_V4_RE.test(rawCategoryId)) {
      return apiError('categoryId は UUID 形式で指定してください', 400)
    }
    const categoryId = rawCategoryId || undefined

    const items = await listDistributorProducts(db, { keyword: kw.keyword, categoryId })
    return NextResponse.json({ items } satisfies DistributorProductsApiResponse)
  } catch (error) {
    return apiError(sanitizeDbError(error, '販売店商品の取得に失敗しました'))
  }
}
```

**完了条件（既存テスト更新を含む。これを含めて1コミットの完了条件とする）**:
- `src/__tests__/api-products.test.ts:50`付近の`listGET()`（引数なし呼び出し）を`listGET(makeRequest('/api/products'))`に修正し、keywordクエリのテストケースを追加する
- `src/app/api/distributor-products/__tests__/route.test.ts`に`GET`のimportを追加し、keyword/categoryIdパラメータのテストケースを新設する（既存のPOSTテストはそのまま維持）

**テスト観点**:
- keyword未指定 → 全件
- keyword=abc → フィルタ適用
- keyword 101文字 → 400
- distributor-products: categoryId不正形式 → 400
- 未認証 → 401
- DBエラー時、レスポンスに生のエラーメッセージ（テーブル名等）が含まれないことを確認する

---

#### Set E-1: ProductSearchFilters コンポーネント

**ファイル**: `src/components/products/ProductSearchFilters.tsx`

Props:
```typescript
type Props = {
  keyword: string
  isLoading: boolean
  onKeywordChange: (value: string) => void
  onClear: () => void
}
```

実装方針:
- `OrderHistoryFilters.tsx`のデバウンス実装（300ms、prevKeywordパターン）を踏襲する前に、まず`OrderHistoryFilters.tsx`が実在し実装が現在のユースケースに適切か確認する
- デバウンス定数`KEYWORD_DEBOUNCE_MS = 300`は`src/constants/search.ts`（新規）に切り出し、`OrderHistoryFilters.tsx`・E-1・E-2が同じ値を参照する
- キーワード入力に`maxLength={100}`属性を設定する
- キーワード入力の`id="product-keyword"`でlabel紐付け
- クリアボタン

**テスト観点** (`ProductSearchFilters.test.tsx`):
- キーワード入力後300ms以内はonKeywordChangeが呼ばれない
- 300ms後にonKeywordChangeが値付きで呼ばれる
- クリアボタンクリックでonClearが呼ばれる
- keyword prop変更時にテキストボックスが同期される（外部クリア対応）
- isLoading=trueのとき、ローディング表示が出る（前回入力値は保持される）

---

#### Set E-2: DistributorProductSearchFilters コンポーネント

**ファイル**: `src/components/distributor-products/DistributorProductSearchFilters.tsx`

Props:
```typescript
type Props = {
  keyword: string
  categoryId: string
  categories: Category[] | undefined // undefined=ローディング中、[]=0件
  isLoading: boolean
  onKeywordChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onClear: () => void
}
```

実装方針:
- キーワード: E-1と同様のデバウンスパターン、`maxLength={100}`
- カテゴリセレクト: `<select>`で`value=""`を「すべてのカテゴリ」オプションとし、変更時は即座に`onCategoryChange`呼び出し（デバウンス不要）
- `categories === undefined`（ローディング中）は「読み込み中…」表示でセレクタdisabled、`categories === []`（0件確定）は通常のdisabled表示、と区別する

**テスト観点** (`DistributorProductSearchFilters.test.tsx`):
- カテゴリ変更でonCategoryChangeが即時呼ばれる
- キーワードdebounceが300ms動作する
- クリアボタンでonClear
- categories === undefinedのとき「読み込み中…」表示
- categories === []のとき通常disabled表示（読み込み中表示ではない）

---

#### Set F-1: /products/page.tsx 統合

**ファイル**: `src/app/products/page.tsx`

変更ポイント:
- `useSearchParams`を追加し`Suspense`でラップする（known-failure-patterns.md対応）
- **既存の`useRouter`ロジック（新規登録・編集・削除遷移）は全て`ProductsPageInner`に移動する**。外側の`ProductsPage`はSuspenseラッパーのみとする
- URLパラメータ`keyword`を読み取り、fetch URLに付与
- `ProductSearchFilters`コンポーネントを配置
- keyword変更時に`router.replace`でURL更新
- 再検索中（isLoading）は既存リストを表示したまま薄いローディング表示を重ねる
- 0件時は「該当する製品がありません」を表示
- fetch失敗時は既存リストを保持し、`role="alert"` + `bg-red-50 text-red-700`スタイルでエラーバナー表示

```tsx
export default function ProductsPage() {
  return (
    <Suspense fallback={<div>読み込み中...</div>}>
      <ProductsPageInner />
    </Suspense>
  )
}

function ProductsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // keyword state, fetch, handleDelete, 新規登録/編集遷移 は全てここに集約
}
```

**テスト観点**:
- URLに`?keyword=abc`があると初期状態で絞り込まれた状態
- キーワード変更でURLが更新される
- クリアでURLパラメータが消える
- 0件時に専用メッセージが表示される
- fetch失敗時に既存リストが消えずエラーバナーが出る

---

#### Set F-2: /distributor-products/page.tsx 統合

**ファイル**: `src/app/distributor-products/page.tsx`

変更ポイント: F-1と同様のSuspenseラップ + `keyword`と`categoryId`の両方をURLパラメータ化

- **categoriesとdistributor-productsのフェッチを2つのuseEffectに分離する**:
  - `categories`は`useEffect(fetchCategories, [])`（マウント時のみ、独立）
  - `distributor-products`は`useEffect(fetchItems, [keyword, categoryId, refreshKey])`
  - DELETE後の`refreshKey`incrementは**distributor-productsのみ**再フェッチを引き起こす。categoriesは再フェッチしない
- keyword・categoryId変更時のみdistributor-products APIを再フェッチ

**テスト観点**: F-1に加え
- categoryId変更でAPIにcategoryIdパラメータが付与される
- keywordとcategoryIdの組み合わせがURLに両方反映される
- DELETE後、distributor-productsは再フェッチされるがcategoriesは再フェッチされない（fetchカウントで確認）

---

### 並列グループ宣言

| グループ | 並列実行可能セット | 触るファイル |
|---|---|---|
| Group 1 | A | `src/lib/search/like-pattern.ts`, `src/lib/api-keyword-query.ts`, `src/lib/api-error.ts`, `src/lib/compatibilities/repository.ts` |
| Group 2（Aに依存） | B | `src/types/product.ts`, `src/types/distributorProduct.ts` |
| Group 3（Bに依存, 並列） | C-products, C-distributor | `src/lib/products/repository.ts`, `src/lib/distributor-products/repository.ts` |
| Group 4（Cに依存, 並列） | D-products, D-distributor, E-1, E-2 | `src/app/api/products/route.ts`, `src/app/api/distributor-products/route.ts`, `src/components/products/ProductSearchFilters.tsx`, `src/components/distributor-products/DistributorProductSearchFilters.tsx` |
| Group 5（D・Eに依存, 並列） | F-1, F-2 | `src/app/products/page.tsx`, `src/app/distributor-products/page.tsx` |

### 実装時に踏む必須チェック

1. **known-failure-patterns.md「Suspenseフォールバック未設定」**: F-1/F-2で`useSearchParams`導入時、Suspenseラップ必須
2. **known-failure-patterns.md「クエリパラメータのバリデーション漏れ」**: Set Dでkeyword長さ上限・categoryId UUID形式チェックを必ず実装（`parseKeyword`経由）
3. **LIKEエスケープは自前実装しない**: 必ず`buildIlikeValue`（Set Aで共有化したもの）を経由する。素の`%${keyword}%`を組み立てない
4. **DBエラーの生メッセージをクライアントに返さない**: 必ず`sanitizeDbError`を経由する
5. **api-pagination.tsの既存定数**: limit/offsetを将来追加する場合は`parsePagination`を再利用（現仕様では不追加）
