import { z } from 'zod'
import limitsConfig from '../../../aidd.config.json'

// WHY: issue #757 の 20（入力の検証）。2026-09-07 の点検で、API の入口に**長さの検査が
//      1 つも無かった**（1 MB の術式名が保存できた）。DB の CHECK 制約（20260907000004）が
//      最後の防波堤として入ったが、そこまで行くと 23514 のエラーになり「何文字までなのか」が
//      利用者に伝わらない。入口で 400 と一緒に上限を伝える。
//
// WHY(設定から読む): 上限は人が決めた値で、リポジトリごとに違う。ここに数字を書くと
//      DB の CHECK と画面と 3 か所に同じ数字が散る。`aidd.config.json` の
//      limits.textLength を唯一の出どころにし、DB との一致は
//      `scripts/check-text-length-consistency.test.sh` が機械で突き合わせる。
//
// WHY(DB を消さない): これは 2 枚目の防御であって置き換えではない。API を通らない経路
//      （RPC の直叩き・service_role）は DB の CHECK だけが守る。

const LIMITS = limitsConfig.limits.textLength

export type TextLimitKey = keyof typeof LIMITS

/** 決めた上限（読み取り専用）。テストと突合スクリプトが参照する */
export const TEXT_LIMITS: Readonly<Record<TextLimitKey, number>> = LIMITS

/** 必須の自由入力。前後の空白を落とし、空文字と上限超過を弾く */
export function requiredText(key: TextLimitKey, label: string) {
  return z
    .string({ error: `${label}は必須です` })
    .trim()
    .min(1, { error: `${label}は必須です` })
    .max(LIMITS[key], { error: `${label}は ${LIMITS[key]} 文字以内で入力してください` })
}

/**
 * 任意の自由入力。未指定・null・空文字をすべて undefined に揃える。
 *
 * WHY(null も受ける): 列が NULL 可なので、画面と既存のクライアントは `null` を送ってくる。
 *      2026-09-07 に `.optional()` だけにしたところ、`description: null` を送る既存のテストが
 *      4 件落ちて気づいた。入口で弾くのは「長すぎる」であって「空である」ではない。
 */
export function optionalText(key: TextLimitKey, label: string) {
  return z
    .string()
    .trim()
    .max(LIMITS[key], { error: `${label}は ${LIMITS[key]} 文字以内で入力してください` })
    .nullish()
    .transform((v) => (v === '' || v === null ? undefined : v))
}

/**
 * zod の検証結果を API の 400 応答に写す。
 *
 * WHY: 最初の 1 件だけを返す。複数返すと「どれを直せばよいか」が分かりにくく、
 *      既存の route が返してきた `{ error: string }` の形も崩れる。
 */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'リクエストが不正です'
}
