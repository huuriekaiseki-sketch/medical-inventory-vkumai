import { z } from 'zod'

// WHY(2026-09-09、判定を 1 か所にする): UUID の形を見る正規表現が **6 か所**にコピーされていた
//      （`schemas.ts` / `client-request-id.ts` / `compat` / `compat/products` / `compat/[id]` /
//        `distributor-products`）。しかも**そのうち 1 つだけ条件が違った**——
//      `distributor-products` は `UUID_V4_RE`（版 4 限定）で、ほかは版を見ない。
//
//      版を見ないのは 2026-09-07 に実測して決めたこと（`schemas.ts` に経緯がある）:
//      PostgreSQL の uuid 型は 16 進 32 桁ならどの版でも受けるので、
//      RFC の版・variant まで縛ると**DB が受ける正当な ID を入口で弾く**。
//      `distributor-products` はその決定と食い違ったまま残っていた。
//
//      いま踏めるかというと踏めない（このリポジトリの ID は `gen_random_uuid()` = 版 4 が作る）。
//      だが**同じ問いに 2 通りの答えがある状態そのもの**が E-053 なので、ここへ寄せる。
//
// WHY(ここで弾きたいのは「明らかに UUID でない文字列」だけ): 存在するかどうかは外部キーが見る。
//      入口の役目は、壊れた値がそのまま問い合わせに乗って 500 になるのを防ぐこと。

/** UUID の形（版・variant は見ない）。この定義がリポジトリで唯一 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 文字列が UUID の形かを見る（存在するかは見ない） */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** 必須の UUID クエリ。`label` は利用者に見せる文言に入る */
export const requiredUuidQuery = (message: string) =>
  z.string({ error: message }).regex(UUID_PATTERN, { error: message })

/** 任意の UUID クエリ。未指定は許し、値があれば形だけ見る */
export const optionalUuidQuery = (message: string) =>
  z.string().regex(UUID_PATTERN, { error: message }).optional()
