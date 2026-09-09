import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { optionalUuidQuery } from '@/lib/validation/uuid'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listCompatibilities, createCompatibility, listProductsInCategory, categoryExists } from '@/lib/compatibilities/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { parseBody } from '@/lib/validation/parse-body'
import { compatibilityInputSchema } from '@/lib/validation/schemas'

// WHY: category_id/product_id_1/product_id_2 はDB上uuid型のためAPI層で形式チェックしておくと
// 不正値をFK違反として捕捉する前に400で弾ける（SPEC Part2 Set D参照）。
// POST の本文は compatibilityInputSchema が見る。
//
// WHY(2026-09-09、クエリを唯一の入口へ): GET のクエリは `parseQuery` で読む。
//      UUID の判定は `validation/uuid.ts` に 1 つだけ（以前はこのファイルにコピーがあった）。
const MAX_KEYWORD_LENGTH = 100
const compatQuerySchema = z.object({
  categoryId: optionalUuidQuery('categoryId の形式が不正です'),
  keyword: z
    .string()
    .max(MAX_KEYWORD_LENGTH, { error: `キーワードは${MAX_KEYWORD_LENGTH}文字以内で入力してください` })
    .optional(),
})

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }

    const parsed = parseQuery(request, compatQuerySchema)
    if (!parsed.ok) return parsed.response
    const { categoryId, keyword } = parsed.data

    const compatibilities = await listCompatibilities(db, { categoryId, keyword })
    return NextResponse.json({ compatibilities })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '互換品の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }

    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)

    const parsed = await parseBody(request, compatibilityInputSchema)
    if (!parsed.ok) return parsed.response
    const { categoryId, productId1, productId2 } = parsed.data
    const note = parsed.data.note ?? null

    // WHY: 正規化前（DB挿入前）の生の値で自己参照を判定する。
    // product_id_1 < product_id_2 の正規化はrepository層の責務のため、ここでは順序を問わない一致のみ見る。
    if (productId1 === productId2) {
      return apiError('同じ製品同士は互換登録できません', 400)
    }

    // WHY: listProductsInCategory はカテゴリが存在しなくても単に空配列を返すため、
    // ここで明示的にカテゴリ存在チェックを行わないと「カテゴリが見つかりません」という
    // SPEC通りの具体的なメッセージを出す経路が実質到達不能になる
    // （下のcreateCompatibilityの23503捕捉はTOCTOU用の最終防壁として残す）。
    const foundCategory = await categoryExists(db, categoryId)
    if (!foundCategory) {
      return apiError('カテゴリが見つかりません', 400)
    }

    const productsInCategory = await listProductsInCategory(db, categoryId)
    const product1 = productsInCategory.find(p => p.id === productId1)
    const product2 = productsInCategory.find(p => p.id === productId2)

    if (!product1 || !product2) {
      return apiError('選択した製品はこのカテゴリに属していません', 400)
    }

    try {
      const compatibility = await createCompatibility(db, { categoryId, productId1, productId2, note })
      return NextResponse.json({ compatibility }, { status: 201 })
    } catch (error) {
      if (error instanceof Error) {
        // WHY: repository層(Set C)は DUPLICATE_COMPATIBILITY_PAIR / CATEGORY_NOT_FOUND
        // という固定識別文字列（大文字）をエラーメッセージとして投げる契約になっている
        // （src/lib/compatibilities/repository.ts の DUPLICATE_COMPATIBILITY_ERROR /
        // CATEGORY_NOT_FOUND_ERROR 参照。動的な製品名はAPI層側で保持しているため）。
        // 大文字小文字を無視した部分一致にすることで、この契約文字列・生のPostgresエラー
        // コード（23505/23503）のどちらでも確実に捕捉する。
        const message = error.message.toLowerCase()
        if (message.includes('duplicate_compatibility_pair') || message.includes('23505') || message.includes('duplicate')) {
          return apiError(
            `すでに登録済みです。【${product1.name}】と【${product2.name}】は既に互換登録されています`,
            409
          )
        }
        if (message.includes('category_not_found') || message.includes('23503') || error.message.includes('見つかりません')) {
          return apiError('カテゴリが見つかりません', 400)
        }
      }
      throw error
    }
  } catch (error) {
    return apiError(toClientErrorMessage(error, '互換品の登録に失敗しました'))
  }
}
