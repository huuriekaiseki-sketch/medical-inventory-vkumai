// E2E/BSGが本番Supabaseに接続するのを防ぐガード。
// NEXT_PUBLIC_SUPABASE_URL のホストが許可リストに無い場合、service role を使った
// 一切の操作（createUser / generateLink 等）が走る前に即座に失敗させる。
// 許可リストはデフォルトでローカルSupabaseのみ。テスト専用のリモートプロジェクトを
// 使う場合は E2E_ALLOWED_SUPABASE_HOSTS にカンマ区切りでホスト名を追加する。

const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost']

type GuardEnv = {
  NEXT_PUBLIC_SUPABASE_URL?: string
  E2E_ALLOWED_SUPABASE_HOSTS?: string
}

export function assertTestSupabaseEnv(env: GuardEnv = process.env as GuardEnv): void {
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) {
    // 未設定の場合は generate-auth-state 側の「認証なしフォールバック」に委ねる
    return
  }

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error(
      `[E2E guard] NEXT_PUBLIC_SUPABASE_URL がURLとして不正です: ${url}`
    )
  }

  const allowedHosts = (env.E2E_ALLOWED_SUPABASE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .concat(DEFAULT_ALLOWED_HOSTS)

  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `[E2E guard] NEXT_PUBLIC_SUPABASE_URL のホスト「${hostname}」はテスト許可ホストではありません。` +
        `本番Supabaseに対するE2E実行をブロックしました。` +
        `.env.test にテスト専用Supabaseの接続情報を設定し、` +
        `リモートのテストプロジェクトを使う場合は E2E_ALLOWED_SUPABASE_HOSTS=${hostname} を明示してください。`
    )
  }
}
