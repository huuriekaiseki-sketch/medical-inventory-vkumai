import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNullableString } from '@/lib/mapping'
import { mapProduct } from '@/lib/products/repository'
import type { Product } from '@/types/product'
import type { ProductCompatibility, ProductCompatibilityInput } from '@/types/compatibility'

// WHY: product_id_1 / product_id_2 は同じ products テーブルへの2本のFKのため、
// デフォルトのPostgres制約名（<table>_<column>_fkey）をヒントに埋め込み(embed)先を明示する。
// これがないとPostgRESTは「どちらのFKで結合するか」を一意に決定できずエラーになる。
const COMPAT_COLUMNS = `
  id,
  category_id,
  product_id_1,
  product_id_2,
  note,
  created_at,
  updated_at,
  category:categories(name),
  product1:products!product_compatibilities_product_id_1_fkey(jan, name, maker),
  product2:products!product_compatibilities_product_id_2_fkey(jan, name, maker)
`

// WHY: keyword検索(.or())はproduct1/product2への埋め込み結合をフィルタ条件の対象にする
// 必要があり、PostgRESTの仕様上「埋め込みリソースの列を条件に使い、かつ一致しない親行を
// 除外する」には対象の埋め込みを inner join 化(!inner)しなければならない（無指定のままだと
// フィルタは埋め込みオブジェクトの中身だけを削るだけで親行の絞り込みには効かない）。
// product_id_1/product_id_2 はNOT NULL FKのため!inner化しても通常時に行が失われることはない。
const COMPAT_COLUMNS_KEYWORD = `
  id,
  category_id,
  product_id_1,
  product_id_2,
  note,
  created_at,
  updated_at,
  category:categories(name),
  product1:products!product_compatibilities_product_id_1_fkey!inner(jan, name, maker),
  product2:products!product_compatibilities_product_id_2_fkey!inner(jan, name, maker)
`

// WHY: DBのINSERT時にエラーコードのみで判定できるよう、API層(Set D)が
// エラーメッセージ文字列（製品名等の動的情報を含む）を組み立てるための目印として
// 固定の識別文字列をエラーメッセージに使う（productの名前はAPI層側で別途保持している）。
export const DUPLICATE_COMPATIBILITY_ERROR = 'DUPLICATE_COMPATIBILITY_PAIR'
export const CATEGORY_NOT_FOUND_ERROR = 'CATEGORY_NOT_FOUND'

interface NestedProductRow {
  jan?: unknown
  name?: unknown
  maker?: unknown
}

interface NestedCategoryRow {
  name?: unknown
}

interface CompatibilityRow {
  id?: unknown
  category_id?: unknown
  product_id_1?: unknown
  product_id_2?: unknown
  note?: unknown
  created_at?: unknown
  updated_at?: unknown
  category?: NestedCategoryRow | NestedCategoryRow[] | null
  product1?: NestedProductRow | NestedProductRow[] | null
  product2?: NestedProductRow | NestedProductRow[] | null
}

// WHY: PostgRESTの多対1埋め込みは通常オブジェクト単体を返すが、クライアントの
// バージョン・スキーマキャッシュの状態によって配列で返るケースがあるため両対応する。
function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

function mapNestedProduct(row: NestedProductRow | undefined): { jan: string; name: string; maker: string | null } {
  return {
    jan: asString(row?.jan),
    name: asString(row?.name),
    maker: asNullableString(row?.maker),
  }
}

export function mapCompatibility(row: CompatibilityRow): ProductCompatibility {
  return {
    id: asString(row.id),
    categoryId: asString(row.category_id),
    categoryName: asString(firstOf(row.category)?.name),
    productId1: asString(row.product_id_1),
    product1: mapNestedProduct(firstOf(row.product1)),
    productId2: asString(row.product_id_2),
    product2: mapNestedProduct(firstOf(row.product2)),
    note: asNullableString(row.note),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export type ListCompatibilitiesFilter = {
  categoryId?: string
  keyword?: string
}

// WHY: keyword に含まれる % / _ はILIKEのワイルドカード文字なのでバックスラッシュで
// エスケープする。一方 , ( ) はPostgRESTの or() 式の区切り・グループ文字として予約されており、
// バックスラッシュエスケープでは効かない（postgrest-jsはこれらをダブルクォートで値全体を
// 囲むことで安全に渡す方式を採用している）。値全体をダブルクォートで囲み、クォート自体と
// バックスラッシュはエスケープする。
function buildIlikeValue(keyword: string): string {
  const wildcardEscaped = keyword
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, (c) => `\\${c}`)
  const quoteEscaped = wildcardEscaped.replace(/"/g, '\\"')
  return `"%${quoteEscaped}%"`
}

// WHY: keyword は product1/product2 双方の name/jan/maker への部分一致(OR)を要件とする
// （SPEC Set C: サーバサイド `.ilike`、Supabaseパラメータバインド、raw SQL禁止）。
// PostgRESTは埋め込みリソースの列を or() の条件パスとして直接指定できるため
// （例: `product1.name.ilike.%kw%`）、!inner化した埋め込みに対し単一の .or() 呼び出しで
// 「product1 or product2 のいずれかの列が一致」を1クエリのDB側フィルタとして表現する。
export async function listCompatibilities(
  db: SupabaseClient,
  filter?: ListCompatibilitiesFilter
): Promise<ProductCompatibility[]> {
  const hasKeyword = Boolean(filter?.keyword)
  let query = db
    .from('product_compatibilities')
    .select(hasKeyword ? COMPAT_COLUMNS_KEYWORD : COMPAT_COLUMNS)
    .order('created_at', { ascending: false })

  if (filter?.categoryId) query = query.eq('category_id', filter.categoryId)

  if (filter?.keyword) {
    const value = buildIlikeValue(filter.keyword)
    query = query.or(
      [
        `product1.name.ilike.${value}`,
        `product1.jan.ilike.${value}`,
        `product1.maker.ilike.${value}`,
        `product2.name.ilike.${value}`,
        `product2.jan.ilike.${value}`,
        `product2.maker.ilike.${value}`,
      ].join(',')
    )
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as CompatibilityRow[]
  return rows.map(mapCompatibility)
}

export async function createCompatibility(
  db: SupabaseClient,
  input: ProductCompatibilityInput
): Promise<ProductCompatibility> {
  // WHY: product_id_1 < product_id_2 のCHECK制約を満たすため、挿入前にUUID文字列を
  // 比較して小さい方を product_id_1 に入れ替える（(a,b)と(b,a)を同一視するための正規化）。
  // PostgresのCHECK制約はuuid型同士の比較（大文字小文字を無視）で評価されるため、
  // JS側の比較も toLowerCase() して揃える（大文字混じりUUID入力時の食い違いを防ぐ）。
  const [productId1, productId2] =
    input.productId1.toLowerCase() < input.productId2.toLowerCase()
      ? [input.productId1, input.productId2]
      : [input.productId2, input.productId1]

  const { data, error } = await db
    .from('product_compatibilities')
    .insert({
      category_id: input.categoryId,
      product_id_1: productId1,
      product_id_2: productId2,
      note: input.note ?? null,
    })
    .select(COMPAT_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') throw new Error(DUPLICATE_COMPATIBILITY_ERROR)
    if (error.code === '23503') throw new Error(CATEGORY_NOT_FOUND_ERROR)
    throw new Error(error.message)
  }
  return mapCompatibility(data)
}

// WHY: 呼び出し元(API route)が「対象が存在しなかった(404)」と「削除できた(200)」を
// 判定できるよう、例外を投げずに真偽値で結果を返す（deleteProductとは異なる方針。
// SPEC Set C参照: 「削除件数0件をハンドリング可能な形で返す」）。
export async function deleteCompatibility(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db
    .from('product_compatibilities')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}

// WHY: POST /api/compat のバリデーションで「存在しないcategoryId」を
// 「選択した製品はこのカテゴリに属していません」という汎用メッセージで誤魔化さず、
// SPEC通り「カテゴリが見つかりません」で明示するために使う。
// listProductsInCategory はカテゴリが存在しなくても単に空配列を返すため
// （distributor_products側に一致行がないだけ）、この判定だけでは
// 「カテゴリ自体が無い」と「カテゴリはあるが対象製品が属していない」を区別できない。
export async function categoryExists(db: SupabaseClient, categoryId: string): Promise<boolean> {
  const { data, error } = await db.from('categories').select('id').eq('id', categoryId).maybeSingle()
  if (error) throw new Error(error.message)
  return Boolean(data)
}

// WHY: products テーブル自体には category_id が存在せず、distributor_products 経由でしか
// 「このカテゴリで有効な製品」を判定できない（SPEC「注意点」参照）。同一製品が複数の
// distributor_products（複数卸）に紐づく場合に重複するため、product.id で去重する。
export async function listProductsInCategory(db: SupabaseClient, categoryId: string): Promise<Product[]> {
  const { data, error } = await db
    .from('distributor_products')
    .select('product:products(id, jan, ref, name, maker, created_at, updated_at)')
    .eq('category_id', categoryId)
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as { product?: unknown }[]
  const seen = new Map<string, Product>()
  for (const row of rows) {
    const nested = firstOf(row.product as (Record<string, unknown> | Record<string, unknown>[] | null | undefined))
    if (!nested) continue
    const product = mapProduct(nested)
    if (product.id && !seen.has(product.id)) seen.set(product.id, product)
  }
  return Array.from(seen.values())
}
