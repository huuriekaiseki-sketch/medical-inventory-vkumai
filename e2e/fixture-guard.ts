// e2e/fixture-guard.ts
//
// WHY(C-030、2026-09-09): spec の後片付けが**自分の作った行以外**を消していないかを、
//      全 spec の前後で実測する。判定そのものは `scripts/lib/fixture-guard.mjs`（DB を知らない）に置き、
//      ここは「実 DB から鍵を読む」「ファイルに残す」だけを受け持つ。
//
//      控えるのは全 spec が走り出す**前**の姿なので、走行中に作った行は入らない
//      （＝自分が作ったものは自由に消せる）。消えて困るのは、
//      **フィクスチャの行**と**前回までの実行が残した行**。

import fs from 'fs'
import path from 'path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertTestSupabaseEnv } from './env-guard'
// WHY(.mjs をそのまま読む): 判定は DB を知らない共有エンジンに置いてある。
//      2 か所に書くと片方だけ古くなる（`scripts/check-fixture-guard.test.sh` が engine 側を測る）
import { PROTECTED_TABLES, keyOf, findVanished } from '../scripts/lib/fixture-guard.mjs'

export const SNAPSHOT_PATH = path.join(process.cwd(), 'e2e', '.auth', 'protected-rows.json')

function serviceClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('[fixture-guard] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

/**
 * 表ごとの鍵を全部読む。ページングして 1,000 行の既定上限で切られないようにする。
 *
 * WHY(公開している): 統合テスト側も**同じ読み方**で控えを取る
 *      （`supabase/__tests__/integration/helpers/fixture-guard.ts`）。
 *      読み方を 2 か所に書くと、片方だけがページングを忘れる形で静かにずれる（E-053）。
 */
export async function readProtectedKeys(db: SupabaseClient = serviceClient()): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const [table, columns] of Object.entries(PROTECTED_TABLES as Record<string, string[]>)) {
    const keys: string[] = []
    const PAGE = 1000
    for (let page = 0; ; page++) {
      const { data, error } = await db
        .from(table)
        .select(columns.join(', '))
        .range(page * PAGE, page * PAGE + PAGE - 1)
      if (error) throw new Error(`[fixture-guard] ${table} の読み出し失敗: ${error.message}`)
      const rows = data ?? []
      for (const row of rows) keys.push(keyOf(table, row))
      if (rows.length < PAGE) break
    }
    out[table] = keys
  }
  return out
}

/** 全 spec の前に、消えては困る行の鍵を控える */
export async function snapshotProtectedRows(): Promise<number> {
  const keys = await readProtectedKeys(serviceClient())
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(keys), 'utf-8')
  return Object.values(keys).reduce((n, list) => n + list.length, 0)
}

/**
 * 全 spec の後に、控えた行がまだあるかを見る。
 * 消えていれば**その場で throw する**（Playwright の globalTeardown は例外で実行を失敗にする）。
 */
export async function verifyProtectedRows(): Promise<void> {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      '[fixture-guard] 控えのファイルがありません。globalSetup が snapshotProtectedRows を呼べていない' +
        '（**控えが無いと「消えていない」と言えてしまう**ので、黙って通さない）'
    )
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'))
  const total = Object.values(snapshot as Record<string, string[]>).reduce((n, l) => n + l.length, 0)
  if (total === 0) {
    // 空の控えで「消えていない」と言うのは何も測っていないのと同じ（C-021）
    throw new Error('[fixture-guard] 控えが 0 件でした。フィクスチャの用意が失敗している可能性があります')
  }

  const present = await readProtectedKeys(serviceClient())
  const gone = findVanished(snapshot, present) as string[]
  if (gone.length === 0) {
    console.log(`[fixture-guard] 走行前からあった ${total} 行はすべて残っています`)
    return
  }
  throw new Error(
    `[fixture-guard] **走り出す前からあった行が ${gone.length} 件消えました**（C-030: 後片付けの範囲が広すぎる）。\n` +
      `  spec の後片付けは「自分が作った行だけ」に絞ってください。\n` +
      `  価格を消すと価格履歴が連鎖で消えるように、**消したつもりのない表まで巻き込む**ことがあります。\n` +
      gone.slice(0, 20).map((g) => `    - ${g}`).join('\n') +
      (gone.length > 20 ? `\n    ... 他 ${gone.length - 20} 件` : '')
  )
}
