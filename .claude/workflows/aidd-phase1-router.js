export const meta = {
  name: 'aidd-phase1-router',
  description: 'taskDescriptionとchangedFiles(変更ファイル一覧)をTRI/RISK基準に照合し、aidd-phase1（軽量Sweep）・aidd-1-1-deep-task（深掘り）・メタ改修(Sweepスキップ)のいずれを起動するか自動判定する。',
  whenToUse: 'Phase 1調査の入り口として使う。DBスキーマ変更・auth/facility/tenant/organization/inventory/RLS/policy等の高リスク判定に加え、.claude/workflows/・.claude/agents/・docs/agents/のみの変更（AIDDパイプライン自体のメタ改修、issue #457）を検知してSweepスキップに振り分ける。呼び出し側は事前に `git diff --name-only` 等で変更（予定）ファイル一覧を取得し、changedFilesとして渡すこと。',
  phases: [
    { title: 'Route', detail: 'ファイルパス（優先）とtaskDescriptionキーワード（補助）でTRI/RISK判定、メタ改修は最優先で分岐' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number, changedFiles?: string[] }
// changedFiles: 変更対象ファイルパスの配列。Workflowスクリプト自体はgit diffを実行できない
//   （filesystem/Node.js APIアクセス無し）ため、呼び出し側（Claude Code）が
//   `git diff --name-only` や変更予定ファイルリストから取得して渡すこと。
// 判定優先順位:
//   1. changedFilesが1件以上あり、全てMETA_PATH_PREFIXES配下 → メタ改修（Sweepスキップ、issue #457）
//   2. changedFilesが1件以上ある場合はパス一致（matchedPaths）のみで判定する。
//      taskDescriptionのキーワード一致は「〜には触れない」等の否定文脈でも単純一致してしまうため
//      （issue #456）、変更対象ファイルが分かっている場合はそちらを信頼する。
//   3. changedFilesが空（未指定含む）の場合のみ、後方互換としてキーワード一致で判定する
//      （issue #286時点の挙動）。
//   正本・単体テストは .claude/workflows/lib/router-risk.js を参照。

// common.md記載のパスベース基準: supabase/migrations/ 配下、src/lib/supabase/ 配下
const RISK_PATH_PREFIXES = ['supabase/migrations/', 'src/lib/supabase/']

// common.md記載のドメインキーワード（ファイルパス・ファイル名に含まれるかで判定）
const RISK_DOMAIN_KEYWORDS = ['auth', 'facility', 'tenant', 'organization', 'inventory', 'rls', 'policy']

// AIDDパイプライン自体（ツール層）のパス（issue #457）。プロダクトコード向けの4軸Sweepは
// これらの変更に対して無意味（対象コードがそもそも存在しないため3軸が「指摘なし」を返すだけ）
// なので、変更ファイルが全てこれらの配下ならSweep自体をスキップし、直接Read/Grep調査へ回す
// （issue #442・#456で実績のあるパターン）。
const META_PATH_PREFIXES = ['.claude/workflows/', '.claude/agents/', 'docs/agents/']

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

function isMetaPath(filePath) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/')
  return META_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への回避策。
// argsが文字列で届いた場合はJSONとしてパースしてから使う。
// 正本・単体テストは .claude/workflows/lib/resolve-workflow-args.js を参照（issue #413）。
// Workflow DSL自体はrequire不可のためインライン複製している（1行のみのためsync testは設けていない）。
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

const taskDescription = parsedArgs?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = parsedArgs?.maxRounds ?? 3
const changedFiles = parsedArgs?.changedFiles ?? []

phase('Route')

const lowerTask = taskDescription.toLowerCase()
const matchedKeywords = RISK_KEYWORDS.filter(kw => lowerTask.includes(kw.toLowerCase()))
const matchedPaths = changedFiles.filter(isHighRiskPath)
const hasChangedFiles = changedFiles.length > 0
const isMetaModification = hasChangedFiles && changedFiles.every(isMetaPath)
const isHighRisk = isMetaModification ? false : hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0

// メタ改修（issue #457）: .claude/workflows/・.claude/agents/・docs/agents/のみの変更は
// プロダクトコード向け4軸Sweepが無意味（3軸が「指摘なし」を返すだけ）なため、Sweep自体を
// 呼ばず直接Read/Grep調査へ回す（issue #442・#456の実績パターン）。isHighRiskの判定より
// 優先する分岐なので、ログ・return共にaidd-1-1-deep-task/aidd-phase1より先に処理する。
if (isMetaModification) {
  log(`メタ改修検知（変更ファイル: ${changedFiles.join(', ')}）→ Sweepをスキップし直接調査へ`)
  return {
    route: 'meta-modification',
    matchedKeywords,
    matchedPaths,
    result: {
      findings: {
        meta: 'AIDDパイプライン自体の変更（.claude/workflows/・.claude/agents/・docs/agents/のみ）のため4軸Sweepをスキップしました。対象ファイルをRead/Grepで直接調査した上でSPEC.mdを作成してください（issue #442・#456と同じ直接調査パターン）。',
      },
      stats: {
        phase: 'phase1',
        agents: 0,
        rounds: 0,
        findingCount: 0,
        blockedCount: 0,
        expectedAgentProgressRecords: 0,
        skipped: true,
        skippedReason: 'meta-modification',
      },
      runManifestSeed: {
        baseCommit: null,
        changedFiles,
      },
    },
  }
}

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
