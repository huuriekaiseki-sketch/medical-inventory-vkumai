import { z } from 'zod'
import { limitedItems, optionalText, requiredText, TEXT_LIMITS } from '@/lib/validation/text-limits'
import { UUID_PATTERN } from '@/lib/validation/uuid'
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

/** 金額。DB の CHECK（I-013）と同じ「0 以上」を入口でも見る */
const money = (label: string) =>
  z
    .number({ error: `${label}は数値で入力してください` })
    .min(0, { error: `${label}は 0 以上で入力してください` })

/**
 * UUID の形まで見る ID。存在するかは DB の外部キーが見る。
 *
 * WHY(版と variant を見ない): PostgreSQL の uuid 型は 16 進 32 桁ならどの版でも受ける。
 *      RFC の版・variant まで縛ると、DB が受ける正当な ID を入口で弾いてしまう
 *      （2026-09-07、厳しくしたところ既存テストの ID が落ちて気づいた）。
 *      ここで弾きたいのは「明らかに UUID でない文字列」だけ。
 *      **2026-09-09 に定義を `validation/uuid.ts` へ移した**（6 か所にコピーされ、
 *      うち 1 つだけ版 4 限定になっていたため）
 */
const UUID_RE = UUID_PATTERN
const uuid = (label: string) =>
  z
    .string({ error: `${label}は必須です` })
    .regex(UUID_RE, { error: `${label}の形式が不正です` })

/**
 * 二重送信対策の鍵（P-053）。未指定は許す（毎回新しい行を作る）。
 * 指定があれば UUID の形だけを見る。値の意味は DB の部分 UNIQUE が守る
 */
const clientRequestId = z
  .string()
  .regex(UUID_RE, { error: 'clientRequestId は UUID で指定してください' })
  .optional()

/** 数量。DB の CHECK（I-010 / I-011、1 以上）と同じ条件を入口でも見る */
const quantity = z
  .number({ error: '数量は数値で入力してください' })
  .int({ error: '数量は整数で入力してください' })
  .min(1, { error: '数量は 1 以上で入力してください' })

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
  // WHY: 共通のヘルパーを使う。素の z.number().min() を書くと DB の CHECK との対応が
  //      追えなくなり、scripts/check-layer-consistency.test.sh も種類を判定できない
  quantity,
  reimbursementPrice: money('償還価格')
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

/**
 * 施設別の仕入価格（hospital_prices）
 *
 * WHY(自由入力が無い): 金額と ID だけ。DB の CHECK（I-013、0 以上）と同じ条件を入口でも見る。
 *      expectedUpdatedAt は楽観ロック（P-052）で、省略すると従来どおり無条件更新になる
 */
export const hospitalPriceInputSchema = z.object({
  distributorProductId: id('代理店商品'),
  facilityId,
  purchasePrice: money('仕切値'),
  deliveryPrice: money('納品価格'),
  expectedUpdatedAt: z.string().optional(),
})

/** 症例発注・短貸返却の明細（JAN が必須） */
export const janItemSchema = z.object({
  jan: requiredText('janOrRef', 'JAN'),
  lot: optionalText('lot', 'ロット'),
  ubd: optionalText('expiryText', '使用期限'),
  quantity,
})

/** 症例発注（case_orders） */
export const caseOrderInputSchema = z.object({
  facilityId,
  caseDatetime: z.string({ error: '症例日時は必須です' }).min(1, { error: '症例日時は必須です' }),
  procedureName: requiredText('procedureName', '手技名'),
  patientId: requiredText('patientId', '患者ID'),
  patientInitials: requiredText('initials', '患者イニシャル'),
  gender: z.enum(['male', 'female', 'other'], {
    error: '性別は male / female / other のいずれかを指定してください',
  }),
  doctorName: requiredText('doctorName', '担当医師名'),
  // WHY(limitedItems、issue #813): 明細の件数に上限を掛ける。発注 4 種とも同じ部品・同じ文言で止める
  items: limitedItems(janItemSchema),
  clientRequestId,
})

/** 短貸発注（loan_orders）。明細は品名が必須で JAN は任意 */
export const loanOrderInputSchema = z.object({
  facilityId,
  procedureName: requiredText('procedureName', '術式名'),
  maker: requiredText('productName', 'メーカー'),
  items: limitedItems(
    z.object({
      jan: optionalText('janOrRef', 'JAN'),
      name: requiredText('productName', '品名'),
      quantity,
    })
  ),
  clientRequestId,
})

/**
 * 短貸返却の明細。JAN の決まりは janItemSchema と同じで、発注明細への紐付けが増える。
 *
 * WHY(janItemSchema を広げない): 同じ形を症例発注も使っている。
 *      症例発注に「返却先の明細」は無いので、返却だけに足す。
 */
const loanReturnItemSchema = janItemSchema.extend({
  loanOrderItemId: uuid('返却対象の明細').optional(),
})

export const loanReturnInputSchema = z.object({
  facilityId,
  returnDatetime: z.string({ error: '返却日時は必須です' }).min(1, { error: '返却日時は必須です' }),
  loanOrderId: z.string().optional(),
  items: limitedItems(loanReturnItemSchema),
  clientRequestId,
})

/**
 * 返却の取り消し（E-056）。**できるのは取り消しだけ**。
 *
 * WHY(status を受け取らない): 自由に状態を入れられる形にすると、`returned` へ戻す・
 *      `draft` にする経路を後から足せてしまう。入口の形で「取り消しだけ」を示す。
 *      `action: 'cancel'` を必須にして、意図しない PATCH が通らないようにする。
 */
export const loanReturnCancelSchema = z.object({
  facilityId,
  action: z.literal('cancel', { error: 'action は cancel のみ指定できます' }),
})

/** 発注 3 種の取り消し（E-056）。返却と同じ形で、**できるのは取り消しだけ** */
export const orderCancelSchema = z.object({
  facilityId,
  action: z.literal('cancel', { error: 'action は cancel のみ指定できます' }),
})

/**
 * 消耗品の使用停止（2026-09-09）。取り消しと同じ形で、**できるのは止めることだけ**。
 * 戻す道は入口の形からして無い（DB のトリガーも `retired` からの遷移を拒む）
 */
export const consumableRetireSchema = z.object({
  facilityId,
  action: z.literal('retire', { error: 'action は retire のみ指定できます' }),
})

/** 消耗品発注（consumable_orders）。明細は消耗品の ID と数量だけ */
export const consumableOrderInputSchema = z.object({
  facilityId,
  items: limitedItems(
    z.object({
      consumableId: id('消耗品'),
      quantity,
    })
  ),
  clientRequestId,
})

/**
 * ロット検索クエリ（issue #803 Set A）
 *
 * WHY(requiredText ではなく専用スキーマ): ロット番号は「1〜100字」という固定値。
 *      他のテキスト入力（productName など）と違い、業務の変数ではなく
 *      この検索機能の仕様に固い値。optionalText / requiredText の体系には入らない。
 *      上限は決定 4 で「500 件（他の検索と揃える）」に決まった value の長さではなく、
 *      入力フィールドの長さ制限。UI と API 両方で `normalizeLotInput` を呼ぶので、
 *      長さの検査は route 側でもアプリ側でも弾ける。
 *
 * WHY(.trim() を .min()/.max() より先に置く): route は「スキーマ検証 → normalizeLotInput
 *      （前後空白を落とす）」の順で処理する。ここで生の空白込み文字列の長さだけを見ると、
 *      空白だけの入力（例: " "）が min(1) を通過してしまい、後段の trim で空文字列になる。
 *      空文字列は buildIlikeValueUnquoted で `%%` になり、ILIKE のワイルドカードとして
 *      「その施設の lot が非 NULL の全行」に一致してしまう（受け入れ条件「入力が空のときは
 *      エラー表示」に反し、実質的に施設内の全ロットが検索結果として漏れる）。
 *      zod の `.trim()` はチェーン内で先に評価されるトランスフォームなので、ここで先に
 *      空白を落としてから min/max を判定すれば、空白だけの入力は 400 で弾かれる。
 *
 * WHY(上限を数字で書かない): 検索語の上限は**保存されている lot の上限と同じ**でなければ意味が無い
 *      （保存値より短ければ引けないロットが出て、長ければ無駄に受ける）。出どころは
 *      aidd.config.json の limits.textLength.lot の 1 か所で、`scripts/check-text-length-consistency.test.sh` が
 *      ここに数字の直書きが増えたら落とす（最初の実装は 100 を直書きしていて、その検査に落ちた）
 */
const LOT_LENGTH_MESSAGE = `1〜${TEXT_LIMITS.lot} 字で入力してください`
export const lotSearchQuerySchema = z.object({
  lot: z
    .string({ error: 'ロット番号は必須です' })
    .trim()
    .min(1, { error: LOT_LENGTH_MESSAGE })
    .max(TEXT_LIMITS.lot, { error: LOT_LENGTH_MESSAGE }),
})

export type ConsumableInputParsed = z.infer<typeof consumableInputSchema>
export type CaseOrderInputParsed = z.infer<typeof caseOrderInputSchema>
export type LoanOrderInputParsed = z.infer<typeof loanOrderInputSchema>
export type LotSearchQueryParsed = z.infer<typeof lotSearchQuerySchema>
