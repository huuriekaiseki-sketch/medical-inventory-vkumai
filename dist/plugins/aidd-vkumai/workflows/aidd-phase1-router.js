export const meta = {
  name: 'aidd-phase1-router',
  description: 'taskDescriptionとchangedFiles(変更ファイル一覧)をTRI/RISK基準・メタ改修基準に照合し、aidd-phase1（軽量Sweep）/aidd-1-1-deep-task（深掘り）/メタ改修軽量ルートのいずれを起動するか自動判定する。',
  whenToUse: 'Phase 1調査の入り口として使う。DBスキーマ変更・auth/facility/tenant/organization/inventory/RLS/policy等の高リスク判定、および.claude/workflows/・.claude/agents/・docs/agents/配下のみのメタ改修判定を機械的に行い、手動判断を不要にする。呼び出し側は事前に `git diff --name-only` 等で変更（予定）ファイル一覧を取得し、changedFilesとして渡すこと。',
  phases: [
    { title: 'Route', detail: 'メタ改修判定（最優先）→ ファイルパス（優先）とtaskDescriptionキーワード（補助）でTRI/RISK判定' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number, changedFiles?: string[], riskConfig?: { keywords?, pathPrefixes?, domainKeywords?, metaPathPrefixes? } }
// changedFiles: 変更対象ファイルパスの配列。Workflowスクリプト自体はgit diffを実行できない
//   （filesystem/Node.js APIアクセス無し）ため、呼び出し側（Claude Code）が
//   `git diff --name-only` や変更予定ファイルリストから取得して渡すこと。
// 判定優先順位（issue #457で3段階に変更。common.md TRI/RISK機械判定基準の節を参照）:
//   1. changedFilesが全てメタ改修パス（metaPathPrefixes）配下 → 最優先でmetaルート
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

// 汎用既定値。リポジトリ・スタック・ドメインに依存しない語だけを置く（共通プラグイン側の正本）。
// 'migration' は path 判定（domainKeywords）にも入れる: 'supabase/migrations/' のような
// 接頭辞はスタック固有なので既定にできないが、パスに migration を含む変更はどのスタックでも
// スキーマ変更である可能性が高い。
const DEFAULT_RISK_CONFIG = {
  keywords: [
    'migrations', 'migration', 'マイグレーション', 'スキーマ',
    'middleware.ts', 'proxy.ts', 'ミドルウェア',
    'auth', '認証', 'ログイン',
    'rls', 'policy', 'ポリシー',
  ],
  pathPrefixes: [],
  domainKeywords: ['auth', 'rls', 'policy', 'migration'],
  // issue #457: パイプライン自体のメタ改修パス（AIDDワークフロー定義・エージェント定義・
  // エージェント向けドキュメント）。プロダクトコードの判定とは別カテゴリであり、
  // 意図的にこの3つのみに限定する（安全側に倒すため、対象を広げない）。
  metaPathPrefixes: ['.claude/workflows/', '.claude/agents/', 'docs/agents/'],
}

// overrides（aidd.config.json の risk、または args.riskConfig）を base に「足す」。
// 配列は和集合（base の順を先に保ち、重複は除く）。base を省略すると汎用既定値。
// 既定値を消す手段は意図的に用意しない（迷ったら高リスク側）。
function resolveRiskConfig(overrides, base) {
  const b = base ?? DEFAULT_RISK_CONFIG
  const o = overrides ?? {}
  const union = (key) => {
    const merged = [...(b[key] ?? [])]
    for (const v of (Array.isArray(o[key]) ? o[key] : [])) {
      if (typeof v === 'string' && v !== '' && !merged.includes(v)) merged.push(v)
    }
    return merged
  }
  return {
    keywords: union('keywords'),
    pathPrefixes: union('pathPrefixes'),
    domainKeywords: union('domainKeywords'),
    metaPathPrefixes: union('metaPathPrefixes'),
  }
}

function isHighRiskPath(filePath, config) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/')
  if (config.pathPrefixes.some(prefix => normalized.startsWith(prefix.toLowerCase()))) return true
  // middleware.ts / proxy.ts はプロジェクト内のすべてが対象（common.md）。
  // proxy.tsはNext.js 16でmiddleware.tsから改名された同一ファイル規約（issue #681）。
  // 移行前後どちらのブランチでも高リスク判定が抜け落ちないよう両方を判定する
  // （middleware.tsの削除は当issueのスコープ外・恒久的に併存させる方針）。
  if (normalized === 'middleware.ts' || normalized.endsWith('/middleware.ts')) return true
  if (normalized === 'proxy.ts' || normalized.endsWith('/proxy.ts')) return true
  return config.domainKeywords.some(kw => normalized.includes(kw.toLowerCase()))
}

function matchTaskKeywords(taskDescription, config) {
  const lower = String(taskDescription ?? '').toLowerCase()
  return config.keywords.filter(kw => lower.includes(kw.toLowerCase()))
}

function isMetaPipelinePath(filePath, config) {
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')
  return config.metaPathPrefixes.some(prefix => normalized.startsWith(prefix.toLowerCase()))
}

// changedFilesが1件以上あり、かつ全件がmetaPathPrefixes配下の場合のみtrue。
// changedFilesが空（未指定）の場合は「メタ改修と確認できない」としてfalseを返し、
// 既存のtaskDescription/パスベース判定（isHighRiskPath・matchTaskKeywords）に委ねる。
function isMetaPipelineOnlyChange(changedFiles, config) {
  const files = changedFiles ?? []
  if (files.length === 0) return false
  return files.every(f => isMetaPipelinePath(f, config))
}

// taskDescription: 人間が書いた説明文（補助判定、後方互換のため残す）
// changedFiles: 変更対象ファイルパスの配列（優先判定。Workflowスクリプト自体はgit diffを
//               実行できない[filesystem/Node.js API access無し]ため、呼び出し側がgit diff等で
//               取得して渡す）
// riskConfig: 導入先の固有語彙（省略時は汎用既定値のみ。resolveRiskConfig で既定値に足す）
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
function classifyRisk(taskDescription, changedFiles = [], riskConfig) {
  const config = resolveRiskConfig(riskConfig)
  const matchedKeywords = matchTaskKeywords(taskDescription, config)
  const matchedPaths = (changedFiles ?? []).filter(f => isHighRiskPath(f, config))
  const hasChangedFiles = (changedFiles ?? []).length > 0
  const isHighRisk = hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0
  return { isHighRisk, matchedKeywords, matchedPaths }
}

// isHighRisk判定に加え、issue #457のメタ改修カテゴリ・issue #500の確認保留カテゴリを
// 含めた4方向ルーティングを決定する。
// isMetaPipelineOnlyChangeをclassifyRisk呼び出しより必ず先に評価する。changedFilesが
// 全てツール層のみの場合、classifyRisk（issue #456の修正でmatchedPathsのみ判定に既に
// なっている）を呼ぶまでもなくmetaルートへ確定させ、Sweep自体を起動しないことでissue #457
// symptom 2（無駄な4軸Sweep実行）を避ける。
// 【issue #500】changedFilesが空（未指定含む）の場合、classifyRiskはキーワード一致のみで
// isHighRiskを決める（否定文脈を区別できない、issue #456で「後方互換のため」意図的に残した
// フォールバック）。changedFilesが空になるのはPhase1調査の主要な呼び出し方であり異常系では
// ないため、このフォールバックはほぼ確実に踏まれ続ける。誤判定時のコストが大きい
// （実測: 77エージェント・約346万トークン）ため、「changedFilesが空 かつ キーワードのみ
// 一致」の場合は自動でdeepルートへ振り分けず、confirmルートとして人間の確認に委ねる
// （decisions/aidd-pipeline.md「なぜchangedFiles空時のキーワード一致フォールバックを人間確認に変えたか」
// 参照）。changedFilesが1件以上ある場合（パスベース判定が効く場合）はこの分岐を通らず、
// 従来通りmatchedPathsのみでisHighRiskが決まる（issue #456の修正は変更しない）。
// 戻り値: { route: 'meta'|'confirm'|'deep'|'light', isHighRisk, isMetaChange, matchedKeywords, matchedPaths }
function classifyRoute(taskDescription, changedFiles = [], riskConfig) {
  const config = resolveRiskConfig(riskConfig)
  if (isMetaPipelineOnlyChange(changedFiles, config)) {
    return { route: 'meta', isHighRisk: false, isMetaChange: true, matchedKeywords: [], matchedPaths: [] }
  }
  const { isHighRisk, matchedKeywords, matchedPaths } = classifyRisk(taskDescription, changedFiles, config)
  const hasChangedFiles = (changedFiles ?? []).length > 0
  if (!hasChangedFiles && matchedKeywords.length > 0) {
    return { route: 'confirm', isHighRisk, isMetaChange: false, matchedKeywords, matchedPaths }
  }
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

// @aidd-local-config:begin
// 導入先固有の TRI/RISK 語彙は args.riskConfig で渡す（生成時に空にした。aidd.config.json の risk を渡すこと）
const LOCAL_RISK_CONFIG = {}
// @aidd-local-config:end

// 汎用既定値 ← LOCAL_RISK_CONFIG ← args.riskConfig の順に「足す」（消せない）。
const riskConfig = resolveRiskConfig(parsedArgs?.riskConfig, resolveRiskConfig(LOCAL_RISK_CONFIG))

const { route, isHighRisk, isMetaChange, matchedKeywords, matchedPaths } = classifyRoute(taskDescription, changedFiles, riskConfig)

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

// issue #500: changedFilesが空（未指定含む）でキーワードのみ一致した場合、深掘り調査
// （数十エージェント・数百万トークン規模）を無人で自動起動せず、workflow()を一切呼ばずに
// 判定保留の結果を返す。呼び出し側（Claude Code）はこの結果を見て、人間に確認してから
// aidd-1-1-deep-task/aidd-phase1のどちらを明示的に呼び出すか判断すること。
if (route === 'confirm') {
  log(`changedFiles未確定でキーワードのみ一致（${matchedKeywords.join(', ')}）→ 深掘りルートへの自動振り分けを保留し、人間の確認を求める`)
  return {
    route: 'aidd-phase1-needs-confirmation',
    matchedKeywords,
    matchedPaths,
    isMetaChange,
    result: {
      needsConfirmation: true,
      reason: `changedFilesが空(未指定)の状態で、taskDescription中のキーワード一致（${matchedKeywords.join('、')}）のみでTRI/RISK該当と判定されました。changedFilesが空になるのはPhase1調査の通常の呼び出し方であり、キーワード一致は「〜には触れない」等の否定文脈を区別できません。深掘り調査（aidd-1-1-deep-task）は数十エージェント・数百万トークン規模のコストがかかるため、実際に高リスクドメインへ触れる変更なのか人間に確認してから起動してください。`,
      suggestion: '対象タスクが実際にauth/facility/tenant/organization/inventory/RLS/policy等のドメインに触れるか確認し、触れる場合はWorkflow(aidd-1-1-deep-task)、触れない場合はWorkflow(aidd-phase1)を明示的に呼び出してください。',
      stats: {
        phase: 'phase1-needs-confirmation',
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
  ? await workflow('aidd-vkumai:aidd-1-1-deep-task', { taskDescription, maxRounds })
  : await workflow('aidd-vkumai:aidd-phase1', { taskDescription })

return {
  route: isHighRisk ? 'aidd-1-1-deep-task' : 'aidd-phase1',
  matchedKeywords,
  matchedPaths,
  isMetaChange,
  result,
}
