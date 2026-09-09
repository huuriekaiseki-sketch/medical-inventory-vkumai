import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import * as fs from 'fs'
import * as path from 'path'
import { assertTestSupabaseEnv } from './env-guard'

// E2Eは本番の .env.local ではなく .env.test のみを読む。
// NODE_ENV=test のとき @next/env は .env.local を読み込まない（Next.js公式仕様）ため、
// 本番Supabaseの接続情報が紛れ込む経路を仕様レベルで断つ。
;(process.env as Record<string, string>).NODE_ENV = 'test'
loadEnvConfig(process.cwd())

// 万一 .env.test やCI secretsに本番URLが設定されていても、ここで即失敗させる
assertTestSupabaseEnv()

/**
 * storageState の中の Supabase 認証 cookie から、そのセッションの持ち主のメールを取り出す。
 *
 * WHY(2026-09-09): 書き出した storageState が**頼んだ人のものとは限らない**ことがあった（下記）。
 *      「サインインできた」ことは cookie の有無でしか見ておらず、**誰の cookie かを一度も見ていなかった**。
 *      長い cookie は `sb-<ref>-auth-token.0` / `.1` と分割されるので、番号順に繋いでから読む。
 */
function readCookieUserEmail(cookies: { name: string; value: string }[]): string | null {
  const chunks = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  if (chunks.length === 0) return null
  const joined = chunks.map((c) => c.value).join('')
  try {
    const session = JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64').toString())
    return typeof session?.user?.email === 'string' ? session.user.email : null
  } catch {
    return null
  }
}

/**
 * 既存ユーザー（email_confirm済み）に対してマジックリンクでサインインし、
 * 認証済みのPlaywright storageStateを authFilePath に書き出す。
 * issue #321: 複数ユーザー分のstorageStateを生成する必要があるため、
 * generateAuthState（単一の固定テストユーザー用）から共通処理として切り出した。
 *
 * WHY(空のコンテキストから始める、2026-09-09): この関数は globalSetup からも **spec の中からも**
 *      呼ばれる。spec の中から呼ぶと、`chromium.launch()` は Playwright テストランナーが
 *      差し替えたものになり、**`playwright.config.ts` の `use.storageState`（共有のテストユーザー）が
 *      新しいコンテキストに引き継がれる**。するとマジックリンクの着地が `/login` ではなく
 *      保護ページになり、`/login` のハッシュ処理（setSession）が走らないまま、
 *      **共有ユーザーの cookie がそのまま書き出される**（2026-09-09 実測。
 *      MFA の spec が「新しく作った利用者」ではなく共有ユーザーとして動き、
 *      共有ユーザーに MFA を付けてしまった）。空の storageState を明示して断つ。
 */
export async function signInAndSaveStorageState(
  supabase: SupabaseClient,
  email: string,
  authFilePath: string
): Promise<void> {
  fs.mkdirSync(path.dirname(authFilePath), { recursive: true })

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const siteOrigin = new URL(siteUrl).origin

  // Admin API でマジックリンクを直接生成（メール送信不要）。
  // redirectToを明示しないとSupabase側のsite_url設定に依存し、127.0.0.1へ飛んで
  // Cookieドメインがずれる事故が起きるため、必ずテストのbaseURLと同じオリジンを指定する
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${siteUrl}/` },
  })

  if (error || !data.properties?.action_link) {
    throw new Error(`テストセッション生成失敗 (${email}): ${error?.message}`)
  }

  // ブラウザでリンクを開いてセッションCookieを取得。
  // 環境変数が揃っているのに認証に失敗した場合は空のstorageStateで誤魔化さず即失敗させる
  // （空stateだと後続テストが未認証のまま走り、原因が分かりにくいリダイレクト失敗として現れるため）
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto(data.properties.action_link)

    // マジックリンク検証後は /#access_token=... や /login#access_token=... など
    // hash付きURLに着地するため、完全一致ではなくオリジン到達で判定する
    await page.waitForURL((url) => url.origin === siteOrigin, { timeout: 30_000 })

    // 認証完了はURLではなくSupabaseのauth Cookie（sb-*-auth-token）の出現で判定する
    // （login/page.tsx のuseEffectがhashからsetSessionし終わるまで非同期のため）
    const deadline = Date.now() + 30_000
    let authenticated = false
    while (Date.now() < deadline) {
      const cookies = await context.cookies()
      if (cookies.some((c) => /^sb-.+-auth-token/.test(c.name))) {
        authenticated = true
        break
      }
      await page.waitForTimeout(500)
    }
    if (!authenticated) {
      throw new Error(
        `[E2E auth] 認証Cookie（sb-*-auth-token）が30秒以内に設定されませんでした (${email})。` +
          'マジックリンクのリダイレクト先とログインフロー（/login のhash処理）を確認してください。'
      )
    }

    // WHY(誰の cookie かを必ず確かめる、2026-09-09): cookie の**有無**だけを見ていたため、
    //      別人のセッションが書き出されても気づけなかった。頼んだ人と違ったら、ここで止める。
    const actual = readCookieUserEmail(await context.cookies())
    if (actual?.toLowerCase() !== email.toLowerCase()) {
      throw new Error(
        `[E2E auth] 書き出そうとした storageState が別人のものです。` +
          `頼んだ人=${email} / 実際=${actual ?? '(読み取れない)'}。` +
          'テストの中からこの関数を呼ぶと use.storageState が引き継がれる問題（2026-09-09）を参照。'
      )
    }

    await context.storageState({ path: authFilePath })
    console.log(`[E2E auth] 認証済みstorageStateを書き出しました: ${authFilePath}`)
  } finally {
    await browser.close()
  }
}

/**
 * メールアドレスから利用者 ID を引く。**全ページを走査する。**
 *
 * WHY(2026-09-08): 以前は `listUsers()` を 1 回だけ呼んで find していた。
 *      既定の `perPage` は **50** なので、手元の DB に利用者がたまると
 *      **居るのに「見つかりません」で落ちる**（実測: 利用者 52 人・固定のテストユーザーは
 *      最初の 50 人に入らず E2E の globalSetup ごと失敗した）。
 *      消せないデータ・たまるデータで既定のページ長に当たって静かに壊れる形は
 *      E-022（拒否記録）・E-023（監査ログ）・E-061（a11y の件数）と同じで、**4 回目**。
 *      「既定のページ長に依存して探さない」が共通の教訓。
 */
async function findUserIdByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<string | null> {
  const perPage = 1000
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`テストユーザー検索失敗: ${error.message}`)
    const hit = data.users.find((u) => u.email === email)
    if (hit) return hit.id
    if (data.users.length < perPage) return null
  }
  return null
}

export async function generateAuthState() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const testEmail = process.env.E2E_TEST_EMAIL

  const authFilePath = path.join(process.cwd(), 'e2e', '.auth', 'user.json')
  fs.mkdirSync(path.dirname(authFilePath), { recursive: true })

  if (!supabaseUrl || !serviceRoleKey || !testEmail) {
    console.warn('[E2E auth] E2E_TEST_EMAIL / SUPABASE_SERVICE_ROLE_KEY が未設定。認証なしで実行します。')
    // 空のstorageStateを書く（Playwrightがファイル不在でクラッシュするのを防ぐ）
    fs.writeFileSync(authFilePath, JSON.stringify({ cookies: [], origins: [] }))
    return
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // テストユーザーが未登録でもgenerateLinkが失敗しないよう、先に明示的に作成しておく。
  // 既に存在する場合はエラーになるが、その場合は「既存ユーザーを使う」で問題ないため無視する。
  const { data: createdUser, error: createUserError } = await supabase.auth.admin.createUser({
    email: testEmail,
    email_confirm: true,
  })
  if (createUserError && createUserError.code !== 'email_exists') {
    throw new Error(`テストユーザー作成失敗: ${createUserError.message}`)
  }

  let testUserId = createdUser?.user?.id
  if (!testUserId) {
    // 既存ユーザーの場合はcreateUserがuserを返さないため、一覧から拾う
    testUserId = (await findUserIdByEmail(supabase, testEmail)) ?? undefined
    if (!testUserId) throw new Error(`テストユーザーが見つかりません: ${testEmail}`)
  }

  // products等のマスタデータ書き込みテストにはadmin権限が必要（is_admin()はuser_facilities.role参照、
  // docs/agents/decisions.md「なぜマスタデータの書き込みをadmin限定にしたか」）。
  // ダミー施設（実在施設名を使わない、docs/agents/common.mdのデータ衛生ルール）にadminとして所属させる。
  const { data: facility, error: facilityError } = await supabase
    .from('facilities')
    .upsert({ name: 'E2Eテスト施設' }, { onConflict: 'name' })
    .select('id')
    .single()
  if (facilityError || !facility) {
    throw new Error(`E2Eテスト施設の作成失敗: ${facilityError?.message}`)
  }

  const { error: membershipError } = await supabase
    .from('user_facilities')
    .upsert(
      { user_id: testUserId, facility_id: facility.id, role: 'admin' },
      { onConflict: 'user_id,facility_id' }
    )
  if (membershipError) {
    throw new Error(`E2Eテストユーザーへのadmin権限付与失敗: ${membershipError.message}`)
  }

  await signInAndSaveStorageState(supabase, testEmail, authFilePath)
}

// CLIから直接実行された場合（npm run e2e:auth 等）にも動くようにする。
// import.meta.url ではなく argv で判定し、tsx実行時のCJS/ESMどちらでも同じ挙動にする。
const isMainModule = process.argv[1]?.endsWith('generate-auth-state.ts')
if (isMainModule) {
  generateAuthState().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
