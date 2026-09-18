// supabase/__tests__/integration/helpers/fixture-guard.ts
//
// WHY(C-030 を統合テストにも広げる、2026-09-09): 「後片付けの範囲が必要より広い」の実測は
//      2026-09-09 時点で **E2E だけ**だった。統合テストは同じローカル DB を共有していて、
//      各ファイルが自分で種をまき自分で消す。つまり **E2E のフィクスチャや別ファイルの行を
//      巻き込んで消せる**——しかも消した本人は緑のまま終わる。
//
//      判定（何が消えたか）は `scripts/lib/fixture-guard.mjs`、
//      読み方（ページングして鍵を集める）は `e2e/fixture-guard.ts` のものをそのまま使う。
//      ここが受け持つのは**統合テスト側の事情**だけ:
//
//        - 控えはファイルに書かず**その場のメモリ**に持つ（globalSetup と teardown は同じ
//          プロセスの同じクロージャ。ファイルにすると前回の残骸を読む事故が増える）
//        - **控えが 0 件でも落とさない**。`supabase db reset` の直後は業務表が空で、
//          それは正しい状態（E2E はフィクスチャを必ずまくので 0 件なら異常、という違い）。
//          ただし「0 件だった＝この実行では何も測っていない」と**必ず出力に残す**
//
// 後片付け漏れ（消し残し）について:
//        ここでは**数えて書き出すだけ**で、合否は決めない。判定は
//        `scripts/run-integration-tests.sh` がする——「全件を回して、緑だったとき」に
//        限らないと意味が無いため（部分実行は他のファイルの行を漏れと読むし、
//        赤い実行は後片付けが途中で止まる）。その 2 つを知っているのはラッパーだけ。
//
// 限界:
//   - 控えが 0 件の実行でも**消し残しは測れる**（0 件からの差分になるため）。
//     測れないのは「消しすぎ」のほうだけ
//   - 消した犯人のファイルは分からない（並列で走るので、消えたことしか分からない）

import fs from 'fs'
import { readProtectedKeys } from '../../../../e2e/fixture-guard'
import { findVanished, findLeaked } from '../../../../scripts/lib/fixture-guard.mjs'

export type ProtectedSnapshot = Record<string, string[]>

/** 控えた鍵の総数 */
export function countKeys(snapshot: ProtectedSnapshot): number {
  return Object.values(snapshot).reduce((n, list) => n + list.length, 0)
}

/** 全ファイルが走り出す前に、消えては困る行の鍵を控える */
export async function snapshotIntegrationRows(): Promise<ProtectedSnapshot> {
  return (await readProtectedKeys()) as ProtectedSnapshot
}

/**
 * 全ファイルが終わったところで、控えた行がまだあるかを見る。
 *
 * WHY(**投げるだけでは落ちない**、2026-09-09 実測): vitest の globalSetup が返した teardown で
 *      throw しても、vitest は `error during close` と出すだけで **exit code 0 のまま**だった
 *      （Playwright の globalTeardown とは違う）。投げるだけの実装は
 *      「壊しても落ちない検査」＝ C-022 そのものになる。
 *      実測した 4 通りの結果:
 *
 *        throw のみ            → exit 0（落ちない）
 *        process.exitCode = 1  → exit 1
 *        process.exit(1)       → exit 1（ただし vitest の後始末を飛ばす）
 *        exitCode を立てて throw → exit 1
 *
 *      なので **`process.exitCode` を立ててから投げる**。投げるのは理由を出力に残すため、
 *      exitCode を立てるのは実行を実際に失敗させるため。
 *      この前提そのものは `scripts/check-fixture-guard.test.sh` の scenario 8 が
 *      毎回 vitest を起動して測り直す（vitest を上げたときに黙って戻らないように）。
 */
export async function verifyIntegrationRows(snapshot: ProtectedSnapshot): Promise<void> {
  const total = countKeys(snapshot)
  const present = (await readProtectedKeys()) as ProtectedSnapshot

  // 後片付け漏れは合否を決めずに書き出すだけ（判定はラッパーの仕事。上の WHY）
  writeLeakReport(findLeaked(snapshot, present) as string[])

  if (total === 0) {
    // WHY(落とさないが黙りもしない): 空の控えで「消えていない」と言うのは何も測っていないのと同じ。
    //      E2E と違って統合テストでは正しく 0 件になりうるので、**事実として出す**だけにする（C-021）。
    console.log(
      '[fixture-guard/integration] 控えが 0 件でした。**この実行では後片付けの範囲を測っていません**' +
        '（db reset の直後など、業務表が空のとき）'
    )
    return
  }

  const gone = findVanished(snapshot, present) as string[]
  if (gone.length === 0) {
    console.log(`[fixture-guard/integration] 走行前からあった ${total} 行はすべて残っています`)
    return
  }
  const message =
    `[fixture-guard/integration] **走り出す前からあった行が ${gone.length} 件消えました**` +
    `（C-030: 後片付けの範囲が広すぎる）。\n` +
    `  統合テストの後片付けは「自分が作った行だけ」に絞ってください。\n` +
    `  価格を消すと価格履歴が連鎖で消えるように、**消したつもりのない表まで巻き込む**ことがあります。\n` +
    `  同じ DB を E2E と共有しているので、E2E のフィクスチャを消すこともできてしまいます。\n` +
    gone.slice(0, 20).map((g) => `    - ${g}`).join('\n') +
    (gone.length > 20 ? `\n    ... 他 ${gone.length - 20} 件` : '')

  // WHY(この順番): exitCode を先に立てる。throw だけでは vitest は exit 0 のままで、
  //      「落ちない検査」になる（上の WHY の実測）。console.error は
  //      `error during close` の整形に埋もれずに理由を出すため。
  console.error(message)
  process.exitCode = 1
  throw new Error(message)
}

/**
 * 後片付け漏れの件数を、指定されたファイルへ書き出す（`INTEGRATION_LEAK_REPORT`）。
 *
 * WHY(ファイル越しに渡す): 判定するのは `scripts/run-integration-tests.sh` だが、
 *      数えられるのはここ（走り出す前の姿を持っているのはこのプロセスだけ）。
 *      環境変数が無いときは書かない——単体で vitest を回したときに
 *      古い報告が残って次の判定を狂わせないため。
 */
function writeLeakReport(leaked: string[]): void {
  const path = process.env.INTEGRATION_LEAK_REPORT
  console.log(
    leaked.length === 0
      ? '[fixture-guard/integration] 走行中に作った行はすべて片付いています（消し残し 0 件）'
      : `[fixture-guard/integration] 走行中に作った行が ${leaked.length} 件残りました（消し残し）`
  )
  if (!path) return
  fs.writeFileSync(path, JSON.stringify({ leaked, count: leaked.length }), 'utf-8')
}
