import { describe, expect, it } from 'vitest'
import limitsConfig from '../../../../aidd.config.json'
import { TEXT_LIMITS, firstIssueMessage, optionalText, requiredText } from '../text-limits'
import { caseOrderInputSchema, consumableInputSchema } from '../schemas'

// WHY: issue #757 の 20。2026-09-07 の点検で、API の入口に長さの検査が 1 つも無く
//      1 MB の術式名が保存できた。ここで固定するのは 3 つ:
//        - 上限は設定（aidd.config.json）の値をそのまま使う（コードに数字を書かない）
//        - ちょうど上限は通り、1 文字超えると弾く（境界）
//        - エラー文に「何文字までか」が入る（利用者が直せる）

describe('入口の文字数の上限', () => {
  it('上限は設定の値をそのまま使う', () => {
    expect(TEXT_LIMITS).toEqual(limitsConfig.limits.textLength)
  })

  it('ちょうど上限は通り、1 文字超えると弾く（必須の項目）', () => {
    const schema = requiredText('procedureName', '術式名')
    const max = TEXT_LIMITS.procedureName
    expect(schema.safeParse('あ'.repeat(max)).success).toBe(true)
    expect(schema.safeParse('あ'.repeat(max + 1)).success).toBe(false)
  })

  it('空文字と空白だけは必須エラーにする', () => {
    const schema = requiredText('procedureName', '術式名')
    expect(schema.safeParse('').success).toBe(false)
    expect(schema.safeParse('   ').success).toBe(false)
  })

  it('前後の空白は落とす', () => {
    const schema = requiredText('procedureName', '術式名')
    const parsed = schema.safeParse('  弁置換術  ')
    expect(parsed.success && parsed.data).toBe('弁置換術')
  })

  it('任意の項目は空文字を未指定として扱う（DB の NULL に対応させる）', () => {
    const schema = optionalText('janOrRef', 'JAN')
    expect(schema.parse('')).toBeUndefined()
    expect(schema.parse(undefined)).toBeUndefined()
    expect(schema.parse(' 4901234567890 ')).toBe('4901234567890')
  })

  it('任意の項目も上限は効く', () => {
    const schema = optionalText('janOrRef', 'JAN')
    expect(schema.safeParse('1'.repeat(TEXT_LIMITS.janOrRef + 1)).success).toBe(false)
  })

  it('エラー文に何文字までかが入る', () => {
    const parsed = requiredText('purpose', '用途').safeParse('あ'.repeat(TEXT_LIMITS.purpose + 1))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(firstIssueMessage(parsed.error)).toContain(String(TEXT_LIMITS.purpose))
      expect(firstIssueMessage(parsed.error)).toContain('用途')
    }
  })
})

describe('書き込み API の本文の形', () => {
  it('消耗品は品名・用途が必須で、長すぎる品名を弾く', () => {
    expect(
      consumableInputSchema.safeParse({ facilityId: 'f1', name: '手袋', purpose: '術中' }).success
    ).toBe(true)
    expect(consumableInputSchema.safeParse({ facilityId: 'f1', name: '手袋' }).success).toBe(false)
    expect(
      consumableInputSchema.safeParse({
        facilityId: 'f1',
        name: 'あ'.repeat(TEXT_LIMITS.productName + 1),
        purpose: '術中',
      }).success
    ).toBe(false)
  })

  it('症例発注は 1 MB の術式名を弾く（2026-09-07 に実際に通っていた入力）', () => {
    const parsed = caseOrderInputSchema.safeParse({
      facilityId: 'f1',
      caseDatetime: '2026-09-07T00:00:00.000Z',
      procedureName: 'あ'.repeat(1_000_000),
      patientId: 'P-1',
      patientInitials: 'ZZ',
      gender: 'other',
      doctorName: '医師',
      items: [],
    })
    expect(parsed.success).toBe(false)
  })

  it('医師名は人が決めた上限（100）で弾く', () => {
    const over = {
      facilityId: 'f1',
      caseDatetime: '2026-09-07T00:00:00.000Z',
      procedureName: '弁置換術',
      patientId: 'P-1',
      patientInitials: 'ZZ',
      gender: 'other' as const,
      items: [],
      doctorName: 'あ'.repeat(TEXT_LIMITS.doctorName + 1),
    }
    expect(caseOrderInputSchema.safeParse(over).success).toBe(false)
    expect(
      caseOrderInputSchema.safeParse({ ...over, doctorName: 'あ'.repeat(TEXT_LIMITS.doctorName) })
        .success
    ).toBe(true)
  })
})
