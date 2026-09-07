import { z } from 'zod'
import { optionalText, requiredText } from '@/lib/validation/text-limits'
import { FACILITY_ROLES } from '@/types/role'

// WHY: issue #757 の 20。書き込み API が受け取る本文の形を 1 か所に集める。
//      route ごとに手書きすると、必ずどれかが長さの検査を忘れる（2026-09-07 は全部忘れていた）。
//      上限の数字はここにも書かない（text-limits.ts が設定から読む）。
//
//      対応する DB の CHECK は migration 20260907000004。列と役割の対応は
//      `scripts/check-text-length-consistency.test.sh` が突き合わせる。

const facilityId = z.string({ error: '施設IDは必須です' }).min(1, { error: '施設IDは必須です' })

/** 必須の ID（空文字を弾く。形が UUID かどうかは DB の外部キーが見る） */
const id = (label: string) =>
  z.string({ error: `${label}の指定は必須です` }).min(1, { error: `${label}の指定は必須です` })

/**
 * UUID の形まで見る ID。存在するかは DB の外部キーが見る。
 *
 * WHY(版と variant を見ない): PostgreSQL の uuid 型は 16 進 32 桁ならどの版でも受ける。
 *      RFC の版・variant まで縛ると、DB が受ける正当な ID を入口で弾いてしまう
 *      （2026-09-07、厳しくしたところ既存テストの ID が落ちて気づいた）。
 *      ここで弾きたいのは「明らかに UUID でない文字列」だけ
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = (label: string) =>
  z
    .string({ error: `${label}は必須です` })
    .regex(UUID_RE, { error: `${label}の形式が不正です` })

/** 消耗品の登録（consumables） */
export const consumableInputSchema = z.object({
  facilityId,
  name: requiredText('productName', '品名'),
  purpose: requiredText('purpose', '用途'),
  jan: optionalText('janOrRef', 'JAN'),
})

/** カテゴリ（categories） */
export const categoryInputSchema = z.object({
  name: requiredText('productName', 'カテゴリ名'),
  description: optionalText('purpose', '説明'),
})

/** 施設（facilities） */
export const facilityInputSchema = z.object({
  name: requiredText('productName', '施設名'),
})

/** 商品マスタ（products） */
export const productInputSchema = z.object({
  jan: requiredText('janOrRef', 'JAN'),
  ref: requiredText('janOrRef', '品番'),
  name: requiredText('productName', '製品名'),
  maker: optionalText('productName', 'メーカー'),
})

/**
 * 代理店商品（distributor_products）
 *
 * WHY(数値もここで見る): 入数と償還価格は DB の CHECK（I-014）が守っているが、
 *      入口で弾けば 23514 ではなく「何が悪いか」を返せる。上限は業務の値ではなく
 *      桁あふれの防止なので、文字数のような「人が決める値」ではない
 */
export const distributorProductInputSchema = z.object({
  productId: id('商品'),
  categoryId: id('カテゴリ'),
  maker: requiredText('productName', 'メーカー'),
  supplier: requiredText('supplierName', '仕入先'),
  name: requiredText('productName', '商品名'),
  quantity: z.number({ error: '入数は数値で入力してください' }).int().min(1, { error: '入数は 1 以上で入力してください' }),
  reimbursementPrice: z
    .number({ error: '償還価格は数値で入力してください' })
    .min(0, { error: '償還価格は 0 以上で入力してください' })
    .nullish()
    .transform((v) => v ?? null),
})

/**
 * 互換ペア（product_compatibilities）
 *
 * WHY(UUID の形も見る): 存在しない ID を DB へ投げると外部キー違反（23503）になり、
 *      利用者には何が悪いか伝わらない。形が違う時点で入口で返す
 */
export const compatibilityInputSchema = z.object({
  categoryId: uuid('カテゴリ ID'),
  productId1: uuid('製品 ID'),
  productId2: uuid('製品 ID'),
  note: optionalText('note', '備考'),
})

/**
 * 施設への所属の付け外し（user_facilities）
 *
 * WHY(役割は固定語): 役割は DB の CHECK も持つ固定語なので、入口でも同じ語だけを通す。
 *      語の一覧は src/types/role.ts の FACILITY_ROLES が正本
 */
export const userFacilityAssignSchema = z.object({
  userId: id('利用者'),
  facilityId: id('施設'),
  role: z.enum(FACILITY_ROLES).optional(),
})

export const userFacilityRemoveSchema = z.object({
  userId: id('利用者'),
  facilityId: id('施設'),
})

/**
 * 招待メール（admin）
 *
 * WHY(形式を見る): メールは外に出ていく唯一の経路（quota-inventory の Q-020）。
 *      形が違うアドレスを Supabase へ渡すと、送信の失敗として上限だけを消費する。
 *
 * WHY(長さも設定から): 254 は RFC 5321 のアドレス長で、人が決めた業務の値ではない。
 *      それでも設定（limits.textLength.emailAddress）に置くのは、**上限の出どころを 1 か所に
 *      保つほうが大事**だから。ここに数字を書くと、次の人が別の場所にも数字を書く
 */
export const inviteInputSchema = z.object({
  email: requiredText('emailAddress', 'メールアドレス').pipe(
    z.string().email({ error: 'メールアドレスの形式が不正です' })
  ),
})

/** 利用者の削除（admin） */
export const deleteUserSchema = z.object({
  userId: id('利用者'),
})

/** 症例発注の見出し（case_orders） */
export const caseOrderHeaderSchema = z.object({
  facilityId,
  procedureName: requiredText('procedureName', '術式名'),
  patientId: requiredText('patientId', '患者 ID'),
  patientInitials: requiredText('initials', '患者イニシャル'),
  doctorName: requiredText('doctorName', '医師名'),
})

/** 短貸発注の見出し（loan_orders） */
export const loanOrderHeaderSchema = z.object({
  facilityId,
  procedureName: requiredText('procedureName', '術式名'),
  maker: requiredText('productName', 'メーカー'),
})

/** 発注・返却の明細（*_order_items / loan_return_items） */
export const orderItemSchema = z.object({
  jan: optionalText('janOrRef', 'JAN'),
  name: optionalText('productName', '品名'),
  lot: optionalText('lot', 'ロット'),
  ubd: optionalText('expiryText', '使用期限'),
})

export type ConsumableInputParsed = z.infer<typeof consumableInputSchema>
export type CaseOrderHeaderParsed = z.infer<typeof caseOrderHeaderSchema>
export type LoanOrderHeaderParsed = z.infer<typeof loanOrderHeaderSchema>
