// aidd-phase1-router.js のTRI/RISK判定ロジック。
// 旧実装はtaskDescription（人間が書いた説明文）のキーワード一致のみで判定しており、
// 実際の変更ファイル・diffを見ていなかった。docs/agents/common.mdのTRI/RISK機械判定基準は
// 「ファイルパス・変更内容」を基準にしているため、実装と基準が一致していなかった（issue #286）。
// 説明文にキーワードが無くても、変更ファイルパスがRLS/auth/facility等のドメインに
// 触れる場合は深掘りパスに振り分ける（ファイルパス一致を優先、キーワード一致は補助判定として残す）。
// aidd-phase1-router.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

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

// AIDDパイプライン自体（ツール層）のパス（issue #457）。プロダクトコード向けの4軸Sweepは
// これらの変更に対して無意味（対象コードがそもそも存在しないため3軸が「指摘なし」を返すだけ）
// なので、変更ファイルが全てこれらの配下ならSweep自体をスキップし、直接Read/Grep調査へ回す
// （issue #442・#456で実績のあるパターン）。
const META_PATH_PREFIXES = ['.claude/workflows/', '.claude/agents/', 'docs/agents/']

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

function matchTaskKeywords(taskDescription) {
  const lower = String(taskDescription ?? '').toLowerCase()
  return RISK_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()))
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
//
// isMetaModification: changedFilesが1件以上あり、かつ全てMETA_PATH_PREFIXES配下の場合にtrue
// （issue #457）。プロダクトコードとの混在（例: ルーターとUIを同時に直す）はメタ改修と
// 扱わない（プロダクトコード側の調査は依然として必要なため）。isMetaModificationがtrueの
// 場合はisHighRiskの判定より優先する（メタ改修パスがdocs/agents/policy-notes.mdのように
// 偶然RISK_DOMAIN_KEYWORDSの語を含んでいても、高リスク扱いにしない）。
export function classifyRisk(taskDescription, changedFiles = []) {
  const matchedKeywords = matchTaskKeywords(taskDescription)
  const matchedPaths = (changedFiles ?? []).filter(isHighRiskPath)
  const hasChangedFiles = (changedFiles ?? []).length > 0
  const isMetaModification = hasChangedFiles && (changedFiles ?? []).every(isMetaPath)
  const isHighRisk = isMetaModification ? false : hasChangedFiles ? matchedPaths.length > 0 : matchedKeywords.length > 0
  return { isHighRisk, matchedKeywords, matchedPaths, isMetaModification }
}
