import { logServerError } from '@/lib/log-safe'
import limitsConfig from '../../../aidd.config.json'

// WHY: issue #757 の 31（fail-open）。2026-09-08 に依存を実際に止めて測ったところ、
//      認可の判定は**向きは正しく拒否側へ倒れる**が、そこまでに時間がかかっていた:
//
//        平常時          PostgREST 停止      GoTrue 停止
//        ------------------------------------------------
//        18 ms           18,493 ms           54,336 ms     requireAuth
//        10 ms           75,389 ms           —             resolveIsAdmin
//         2 ms           55,297 ms           —             requireFacilityAccess
//
//      `supabase-js` の fetch にタイムアウトが無く、居ない upstream を待ち続けるため。
//      **`requireAuth` は全 route が通る**ので、PostgREST が落ちると認可に関係ない読み取りまで
//      巻き込まれる。Vercel の関数はその前に打ち切られるので、利用者には 504 になる。
//
// WHY(判定だけに効かせる): 2026-09-08 に人が決めた。判定は本来ミリ秒で終わるので、
//      切っても失うものが無い（材料が取れないなら拒否、が元の設計そのまま）。
//      重い一覧・集計レポートは正当に遅いことがあるので巻き込まない。
//
// WHY(5 秒): 同じく人が決めた値。平常時の 2〜18 ms に対して 250 倍以上の余裕がある。
//      **本番（プール・リージョン越し）では未測定**なので、遅い経路があれば切られる危険は残る。
//
// 既知の限界:
//   - **要求そのものは止めない。待つのをやめるだけ**で、裏の fetch は走り続ける。
//     利用者への応答は上限で返るが、接続はしばらく残る。
//     RPC だけは `.abortSignal()` で本当に中断できるが、**採らなかった**。理由は 2 つ:
//       (1) 測った壊れ方は「upstream が居ない」なので、中断しても解放されるものが無い
//       (2) 呼び出しの形が変わり、既存のモック 5 ファイルが「chain を持たない」ために全部落ちる。
//           **仕組みを 1 つに保つ**ほうが、抜けのある 2 本立てより安全と判断した
//     正当に遅い DB を切りたくなったら、そのときは abortSignal 側へ寄せる（モックも直す）。
//   - 諦めたことは**呼び出し側からは「材料が取れなかった」と同じに見える**。
//     「上限に達した」と「本当に権限が無い」は区別できない（記録は下のログにだけ出る）。
//   - **重い一覧・レポートには効かせていない**（2026-09-08 の判断）。そこが遅いままなのは既知。

/** 認可・認証の判定が待つ上限（人が決めた値。aidd.config.json の limits） */
export const AUTH_JUDGMENT_TIMEOUT_MS: number = limitsConfig.limits.authJudgmentTimeoutMs

/** 判定が上限を超えたときに投げる印。ログで「拒否」と「遅くて諦めた」を見分けるために型を分ける */
export class JudgmentTimeoutError extends Error {
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`judgment timed out after ${timeoutMs}ms: ${label}`)
    this.name = 'JudgmentTimeoutError'
  }
}

/**
 * 判定の待ち時間に上限を付ける。上限を超えたら `onTimeout()` の値を返す。
 *
 * 戻り値の形を**呼び出し側が既に扱っている形**（`{ data, error }` 等）に合わせるのが要点。
 * 新しい分岐を足すと、そこだけ fail-closed が抜ける余地ができる。
 */
export async function withJudgmentTimeout<T>(
  label: string,
  run: () => PromiseLike<T>,
  onTimeout: () => T,
  timeoutMs: number = AUTH_JUDGMENT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'__timeout__'>((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), timeoutMs)
  })
  try {
    const result = await Promise.race([run(), timeout])
    if (result !== '__timeout__') return result as T
    // WHY(ここで必ず記録する): 呼び出し側に任せると、**書き忘れた経路だけが無音**になる。
    //      諦めたことが見えないと「拒否が増えた」としか読めず、原因に辿り着けない
    logServerError('judgment-timeout', new JudgmentTimeoutError(label, timeoutMs))
    return onTimeout()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

