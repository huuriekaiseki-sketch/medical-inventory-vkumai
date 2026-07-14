export const meta = {
  name: 'aidd-phase1-router',
  description: 'taskDescriptionとchangedFiles(変更ファイル一覧)をTRI/RISK基準に照合し、aidd-phase1（軽量Sweep）とaidd-1-1-deep-task（深掘り）のどちらを起動するか自動判定する。',
  whenToUse: 'Phase 1調査の入り口として使う。DBスキーマ変更・auth/facility/tenant/organization/inventory/RLS/policy等の高リスク判定を機械的に行い、手動判断を不要にする。呼び出し側は事前に `git diff --name-only` 等で変更（予定）ファイル一覧を取得し、changedFilesとして渡すこと。',
  phases: [
    { title: 'Route', detail: 'ファイルパス（優先）とtaskDescriptionキーワード（補助）でTRI/RISK判定' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number, changedFiles?: string[] }
// changedFiles: 変更対象ファイルパスの配列。Workflowスクリプト自体はgit diffを実行できない
//   （filesystem/Node.js APIアクセス無し）ため、呼び出し側（Claude Code）が
//   `git diff --name-only` や変更予定ファイルリストから取得して渡すこと。
// 判定優先順位: changedFilesのパス一致（common.md TRI/RISK基準）を優先し、
//   taskDescriptionのキーワード一致は補助判定として残す（どちらか一方でも該当すれば深掘りへ。issue #286）

// common.md記載のパスベース基準: supabase/migrations/ 配下、src/lib/supabase/ 配下
const RISK_PATH_PREFIXES = ['supabase/migrations/', 'src/lib/supabase/']

// common.md記載のドメインキーワード（ファイルパス・ファイル名に含まれるかで判定）
const RISK_DOMAIN_KEYWORDS = ['auth', 'facility', 'tenant', 'organization', 'inventory', 'rls', 'policy']

const RISK_KEYWORDS = [
  // パス由来
  'migrations', 'migration', 'マイグレーション', 'スキーマ',
  'src/lib/supabase', 'middleware.ts', 'ミドルウェア',
  // ドメイン由来（common.md TRI/RISK基準）
  'auth', '認証', 'ログイン',
  'facility', '施設',
  'tenant', 'テナント',
  'organization', '組織',
  'inventory', '在庫',
  'rls', 'policy', 'ポリシー',
]

// 意図的に安全側に倒す（common.md TRI/RISK原則: 迷ったら高リスク側）。
// false positive（軽微なタスクが深掘りに回る＝時間コスト増）は許容し、
// false negative（高リスク変更を軽量版で見逃す）は許容しない。

function isHighRiskPath(filePath) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/')
  if (RISK_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true
  // middleware.ts はプロジェクト内のすべてのmiddlewareが対象（common.md）
  if (normalized === 'middleware.ts' || normalized.endsWith('/middleware.ts')) return true
  return RISK_DOMAIN_KEYWORDS.some(kw => normalized.includes(kw))
}

// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への回避策。
// argsが文字列で届いた場合はJSONとしてパースしてから使う。
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

const taskDescription = parsedArgs?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = parsedArgs?.maxRounds ?? 3
const changedFiles = parsedArgs?.changedFiles ?? []

phase('Route')

const lowerTask = taskDescription.toLowerCase()
const matchedKeywords = RISK_KEYWORDS.filter(kw => lowerTask.includes(kw.toLowerCase()))
const matchedPaths = changedFiles.filter(isHighRiskPath)
const isHighRisk = matchedKeywords.length > 0 || matchedPaths.length > 0

log(
  isHighRisk
    ? `TRI/RISK該当（キーワード: ${matchedKeywords.join(', ') || 'なし'} / 変更ファイル: ${matchedPaths.join(', ') || 'なし'}）→ aidd-1-1-deep-task を起動`
    : 'TRI/RISK該当なし → aidd-phase1（軽量Sweep）を起動'
)

const result = isHighRisk
  ? await workflow('aidd-1-1-deep-task', { taskDescription, maxRounds })
  : await workflow('aidd-phase1', { taskDescription })

return {
  route: isHighRisk ? 'aidd-1-1-deep-task' : 'aidd-phase1',
  matchedKeywords,
  matchedPaths,
  result,
}
