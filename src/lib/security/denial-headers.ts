import { z } from 'zod'

// WHY: issue #757 の 24。拒否の記録（access_denials）に「どの経路か」を残すため、
//      proxy が転送リクエストへパスとメソッドを付け、Route Handler 側のガードがそれを読む。
//      Route Handler は自分のパスを知る手段を持たないので、proxy が渡すしかない。
//
// WHY(#757-24 の残り、2026-09-13。ヘッダに加えて cookie も持つ): proxy が admin パスを
//      /login へ跳ね返す経路は Route Handler が動かないので、上のヘッダでは記録できない。
//      転送後の要求は経路が /login になり、元の経路をヘッダで運べないため、転送応答に
//      httpOnly cookie（印）を載せ、/login の Server Component が読んで記録する。
//      ヘッダ（Route Handler 用）と cookie（proxy の転送用）は用途が違い、どちらも残す。
//
// WHY(このファイルを分けた): proxy は Edge Runtime で動く。記録本体
//      （src/lib/security/access-denial.ts）は service role キーを参照するので、
//      proxy から import すると Edge のバンドルに入ってしまう。名前だけを持つこのファイルなら
//      どちらからも安全に読める。
//
// WHY(必ず上書きする・ヘッダ): クライアントが同じ名前のヘッダを送ってきても proxy が毎回上書きする。
//      証跡に偽の経路を書かせないため。
//
// 限界（cookie）: httpOnly は JavaScript からの読み書きを防ぐだけで、curl 等で任意の cookie を
//      送ること自体は防げない（proxy は /login への要求で印を消すが、その要求自体は
//      Server Component が読む）。そのため印には理由・経路・メソッドしか入れず、actor_id は
//      /login 側がそのリクエストのセッションから取る。2026-09-13 の直接攻撃の実測: 偽の
//      not_admin はセッションが無ければ記録されず（getUser が失敗してスキップ）、偽の
//      unauthenticated だけが actor_id NULL の匿名行として残る。他人に濡れ衣は着せられない。
//      経路は parseProxyDenial が形を検証する（201 文字は不記録を実測）。

export const DENIAL_ROUTE_HEADER = 'x-aidd-route'
export const DENIAL_METHOD_HEADER = 'x-aidd-method'

export const DENIAL_COOKIE_NAME = 'aidd-denial'

// WHY(2026-09-13、E2E で発覚): proxy が /login の応答で印の cookie を消すと、Next.js は
//      同じリクエスト内の Server Component の cookies() にもその削除を反映する
//      （x-middleware-set-cookie）。つまり Server Component が読む前に印が消えて記録が 0 件になる。
//      そこで proxy は、/login への要求に印が付いていたらその中身を**転送リクエストのヘッダ**に
//      載せ替え（クライアントが同名ヘッダを送っても必ず上書き・無ければ削除）、cookie は応答で消す。
//      Server Component は cookie ではなくこのヘッダを読む。
export const DENIAL_PAYLOAD_HEADER = 'x-aidd-denial'

/**
 * proxy が /login への転送応答に載せる httpOnly cookie の内容。
 *
 * WHY(型でなく interface): コンストラクタを避けるため。実行時は JSON 文字列を parse するので
 *      クラスのインスタンスは不要で、単なる辞書で十分
 */
export interface ProxyDenialPayload {
  /** 拒否の理由。proxy の分岐がそのまま排他になる */
  reason: 'unauthenticated' | 'not_admin'
  /** 実際に叩かれたパス（proxy が付ける）。偽造は可能なので parse で形を検証し、200 文字超は拒否 */
  route: string
  /** 実際のメソッド。分析用（GET と POST の並び）で判定には使わない */
  method: string
}

/**
 * ProxyDenialPayload を JSON 文字列に符号化する。
 *
 * WHY: 単なる JSON.stringify。ここで関数にする理由は「いつ誰が何をしているか」を
 *      code search で追えるようにするため（proxy.ts と /login/page.tsx の両端を
 *      単一の`encodeProxyDenial`で見つけられる）
 */
export function encodeProxyDenial(payload: ProxyDenialPayload): string {
  return JSON.stringify(payload)
}

/**
 * proxy が載せた cookie を読み込み、ProxyDenialPayload を復元する。
 * 形が壊れている場合は null を返す（記録をスキップし、/login は描画を続ける）。
 *
 * 検証内容:
 *   - JSON でない
 *   - reason が 'unauthenticated' / 'not_admin' のいずれでもない
 *   - route が 200 文字超
 *   - route / method に制御文字（0x00–0x1f、0x7f）が含まれる
 */
export function parseProxyDenial(raw: string | undefined): ProxyDenialPayload | null {
  if (!raw) return null

  // JSON のパース失敗は null で返す（壊れた形）
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }

  // zod で型と内容を検証
  const schema = z
    .object({
      reason: z.enum(['unauthenticated', 'not_admin']),
      route: z
        .string()
        .max(200, { message: 'route exceeds 200 characters' })
        .refine(
          (s) => !/[\x00-\x1f\x7f]/.test(s),
          { message: 'route contains control characters' },
        ),
      method: z
        .string()
        .refine(
          (s) => !/[\x00-\x1f\x7f]/.test(s),
          { message: 'method contains control characters' },
        ),
    })
    .strict() // 余分なプロパティは拒否

  const result = schema.safeParse(payload)
  return result.success ? result.data : null
}
