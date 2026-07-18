export const meta = {
  name: 'aidd-phase1-router',
  description: 'taskDescriptionとchangedFiles(変更ファイル一覧)をTRI/RISK基準・メタ改修基準に照合し、aidd-phase1（軽量Sweep）/aidd-1-1-deep-task（深掘り）/メタ改修軽量ルートのいずれを起動するか自動判定する。',
  whenToUse: 'Phase 1調査の入り口として使う。DBスキーマ変更・auth/facility/tenant/organization/inventory/RLS/policy等の高リスク判定、および.claude/workflows/・.claude/agents/・docs/agents/配下のみのメタ改修判定を機械的に行い、手動判断を不要にする。呼び出し側は事前に `git diff --name-only` 等で変更（予定）ファイル一覧を取得し、changedFilesとして渡すこと。',
  phases: [
    { title: 'Route', detail: 'メタ改修判定（最優先）→ ファイルパス（優先）とtaskDescriptionキーワード（補助）でTRI/RISK判定' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number, changedFiles?: string[] }
// changedFiles: 変更対象ファイルパスの配列。Workflowスクリプト自体はgit diffを実行できない
//   （filesystem/Node.js APIアクセス無し）ため、呼び出し側（Claude Code）が
//   `git diff --name-only` や変更予定ファイルリストから取得して渡すこと。
// 判定優先順位（issue #457で3段階に変更。common.md TRI/RISK機械判定基準の節を参照）:
//   1. changedFilesが全てメタ改修パス（META_PATH_PREFIXES）配下 → 最優先でmetaルート
//      （Sweep自体を起動しない。issue #457 症状2対策）
//   2. 上記に該当しなければ、changedFilesが1件以上ある場合はパス一致（matchedPaths）のみで
//      isHighRiskを判定する。taskDescriptionのキーワード一致は「〜には触れない」等の
//      否定文脈でも単純一致してしまうため（issue #456）、変更対象ファイルが分かっている
//      場合はそちらを信頼する。changedFilesが空（未指定含む）の場合のみ、後方互換として
//      キーワード一致で判定する（issue #286時点の挙動）。
// 以下のconst/function群は .claude/workflows/lib/router-risk.js の正本と一字一句同期している
// （同期は .claude/workflows/lib/__tests__/router-risk-sync.test.js が検証する。issue #457）。

// 意図的に安全側に倒す（common.md TRI/RISK原則: 迷ったら高リスク側）。
// false positive（軽微なタスクが深掘りに回る＝時間コスト増）は許容し、
// false negative（高リスク変更を軽量版で見逃す）は許容しない。

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

// common.md記載のパスベース基準: supabase/migrations/ 配下、src/lib/supabase/ 配下
const RISK_PATH_PREFIXES = ['supabase/migrations/', 'src/lib/supabase/']

// common.md記載のドメインキーワード（ファイルパス・ファイル名に含まれるかで判定）
const RISK_DOMAIN_KEYWORDS = ['auth', 'facility', 'tenant', 'organization', 'inventory', 'rls', 'policy']

function isHighRiskPath(filePath) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/')
  if (RISK_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true
  // middleware.ts はプロジェクト内のすべてのmiddlewareが対象（common.md）
  if (normalized === 'middleware.ts' || normalized.endsWith('/middleware.ts')) return true
  return RISK_DOMAIN_KEYWORDS.some(kw => normalized.includes(kw))
}

function matchTaskKeywords(taskDescription) {
  const lower = String(taskDescription ?? '').toLowerCase()
  return RISK_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()))
}

// issue #457: パイプライン自体のメタ改修パス（AIDDワークフロー定義・エージェント定義・
// エージェント向けドキュメント）。プロダクトコードのRISK_PATH_PREFIXES/RISK_DOMAIN_KEYWORDS
// とは別カテゴリであり、意図的にこの3つのみに限定する（安全側に倒すため、対象を広げない）。
const META_PATH_PREFIXES = ['.claude/workflows/', '.claude/agents/', 'docs/agents/']

function isMetaPipelinePath(filePath) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')
  return META_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

// changedFilesが1件以上あり、かつ全件がMETA_PATH_PREFIXES配下の場合のみtrue。
// changedFilesが空（未指定）の場合は「メタ改修と確認できない」としてfalseを返し、
// 既存のtaskDescription/パスベース判定（isHighRiskPath・matchTaskKeywords）に委ねる。
function isMetaPipelineOnlyChange(changedFiles) {
  const files = changedFiles ?? []
  if (files.length === 0) return false
  return files.every(isMetaPipelinePath)
}

// taskDescription: 人間が書いた説明文（補助判定、後方互換のため残す）
// changedFiles: 変更対象ファイルパスの配列（優先判定。Workflowスクリプト自体はgit diffを
//               実行できない[filesystem/Node.js API access無し]ため、呼び出し側がgit diff等で
//               取得して渡す）
// 戻り値: { isHighRisk, matchedKeywords, matchedPaths }
//
// changedFilesが1件以上渡されている場合はmatchedPaths（パスベース判定）のみでisHighRiskを
// 決める。taskDescriptionのキーワード一致は「〜には触れない」のような否定文脈でも単純な
// 単語出現で一致してしまい、実際には対象外のパスしか変更しないタスクを高リスクと誤判定する
// ことがあった（issue #456：matchedPaths: []なのにmatchedKeywordsだけで深掘り調査に誤って
// 振り分けられ、無関係なドメインの大規模Sweepが走った実例）。変更対象ファイルが分かっている
// 場合はそちらの方が確度が高いため、そちらを信頼する。
// changedFilesが空（未指定含む）の場合は、パスベース判定ができないため、後方互換として
// キーワード一致のみで判定する（issue #286時点の挙動を維持）。
// matchedKeywordsはisHighRiskの判定に使われない場合でも、補助情報としてそのまま返す。
function classifyRisk(taskDescription, changedFiles = []) {
  const matchedKeywords = matchTaskKeywords(taskDescription)
  const matchedPaths = (changedFiles ?? []).filter(isHighRiskPath)
  const hasChangedFiles = (changedFiles ?? []).length > 0
  const isHighRisk = hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0
  return { isHighRisk, matchedKeywords, matchedPaths }
}

// isHighRisk判定に加え、issue #457のメタ改修カテゴリを含めた3方向ルーティングを決定する。
// isMetaPipelineOnlyChangeをclassifyRisk呼び出しより必ず先に評価する。changedFilesが
// 全てツール層のみの場合、classifyRisk（issue #456の修正でmatchedPathsのみ判定に既に
// なっている）を呼ぶまでもなくmetaルートへ確定させ、Sweep自体を起動しないことでissue #457
// symptom 2（無駄な4軸Sweep実行）を避ける。
// 戻り値: { route: 'meta'|'deep'|'light', isHighRisk, isMetaChange, matchedKeywords, matchedPaths }
function classifyRoute(taskDescription, changedFiles = []) {
  if (isMetaPipelineOnlyChange(changedFiles)) {
    return { route: 'meta', isHighRisk: false, isMetaChange: true, matchedKeywords: [], matchedPaths: [] }
  }
  const { isHighRisk, matchedKeywords, matchedPaths } = classifyRisk(taskDescription, changedFiles)
  return { route: isHighRisk ? 'deep' : 'light', isHighRisk, isMetaChange: false, matchedKeywords, matchedPaths }
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

const { route, isHighRisk, isMetaChange, matchedKeywords, matchedPaths } = classifyRoute(taskDescription, changedFiles)

// issue #457: メタ改修（.claude/workflows/・.claude/agents/・docs/agents/配下のみの変更）は
// TRI/RISK判定そのものを迂回し、4軸Sweep（aidd-phase1）も深掘り調査（aidd-1-1-deep-task）も
// 起動しない専用ルート。ui/data/typesの3軸が「対象コードが無いので当然指摘なし」を返すだけの
// 無駄な実行（症状2）を避けるため、workflow()を一切呼ばず直接設計検討に進む前提の結果を返す。
if (route === 'meta') {
  log(`メタ改修検知（変更ファイル: ${changedFiles.join(', ') || 'なし'}）→ Sweepをスキップし、直接設計検討へ進む軽量ルート`)
  return {
    route: 'aidd-phase1-meta',
    matchedKeywords,
    matchedPaths,
    isMetaChange,
    result: {
      findings: {
        meta: '`.claude/workflows/`・`.claude/agents/`・`docs/agents/`配下のみの変更のため、4軸Sweep（ui/data/db/types）は実行していません。プロダクトコードへの影響が無いことを前提に、直接設計・実装検討に進んでください。',
      },
      stats: {
        phase: 'phase1-meta',
        agents: 0,
        rounds: 0,
        findingCount: 0,
        blockedCount: 0,
        expectedAgentProgressRecords: 0,
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
  isMetaChange,
  result,
}
