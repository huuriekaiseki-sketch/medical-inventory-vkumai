import { z } from 'zod'
import { optionalText, requiredText } from '@/lib/validation/text-limits'

// WHY: issue #757 の 20。書き込み API が受け取る本文の形を 1 か所に集める。
//      route ごとに手書きすると、必ずどれかが長さの検査を忘れる（2026-09-07 は全部忘れていた）。
//      上限の数字はここにも書かない（text-limits.ts が設定から読む）。
//
//      対応する DB の CHECK は migration 20260907000004。列と役割の対応は
//      `scripts/check-text-length-consistency.test.sh` が突き合わせる。

const facilityId = z.string({ error: '施設IDは必須です' }).min(1, { error: '施設IDは必須です' })

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
  name: requiredText('productName', '商品名'),
  maker: optionalText('productName', 'メーカー'),
  ref: optionalText('janOrRef', '品番'),
})

/** 代理店商品（distributor_products） */
export const distributorProductInputSchema = z.object({
  name: requiredText('productName', '商品名'),
  maker: optionalText('productName', 'メーカー'),
  supplier: optionalText('supplierName', '仕入先'),
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
