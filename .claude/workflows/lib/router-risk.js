// aidd-phase1-router.js のTRI/RISK判定ロジック。
// 旧実装はtaskDescription（人間が書いた説明文）のキーワード一致のみで判定しており、
// 実際の変更ファイル・diffを見ていなかった。docs/agents/common.mdのTRI/RISK機械判定基準は
// 「ファイルパス・変更内容」を基準にしているため、実装と基準が一致していなかった（issue #286）。
// 説明文にキーワードが無くても、変更ファイルパスがRLS/auth/facility等のドメインに
// 触れる場合は深掘りパスに振り分ける（ファイルパス一致を優先、キーワード一致は補助判定として残す）。
// aidd-phase1-router.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。同期は
// .claude/workflows/lib/__tests__/router-risk-sync.test.js が検証する（issue #457）。
//
// 【issue #420 v1 セット B】エンジン（判定ロジック）と語彙（リポジトリ固有の値）を分離した。
// このファイルに残る既定値 DEFAULT_RISK_CONFIG は、どのリポジトリでも高リスクと言える汎用語
// （auth / rls / policy / migration とファイル名規則）だけにし、リポジトリ固有の語
// （施設・テナント等のドメイン語、DB クライアント配下のようなスタック固有パス）はリポジトリ直下の
// aidd.config.json（導入先アダプター）へ移した。呼び出し側は classifyRoute の第3引数で
// 設定を渡す（derive は aidd.config.json を読んで渡す。aidd-phase1-router.js は Workflow DSL
// でファイルを読めないため、LOCAL_RISK_CONFIG をインラインで持ち、args.riskConfig で上書きできる）。
// 設定は既定値に「足す」だけで、既定値を消すことはできない（迷ったら高リスク側）。
//
// 【issue #457】パイプライン自体のメタ改修（.claude/workflows/・.claude/agents/・
// docs/agents/配下のみの変更）は、プロダクトコード向けのTRI/RISK基準（keywords の
// 単純文字列一致）にかけると2つの問題が起きていた:
//   1. taskDescriptionに「DB/RLS/authには触れない」という否定文を書いても"auth"等の単語が
//      キーワード一致し、changedFilesが実際は高リスク領域に一切該当しないのに深掘り調査へ
//      誤って振り分けられる（キーワードマッチは文脈を解釈しないため）。
//      ※この症状自体は、changedFiles提供時にmatchedPathsのみでisHighRiskを決めるよう
//      classifyRisk側を修正したことで既に解消済み（issue #456、下記classifyRiskのコメント参照）。
//   2. 軽量Sweepの4軸（UI/データ/DB/型）はプロダクトコード向けの分類軸であり、
//      ツール層の変更に対してはui/data/types軸が「対象コードが無いので当然指摘なし」を
//      返すだけの無駄な実行になる（issue #456では未解決。issue #457のスコープ）
// 対応: 「changedFilesが全てツール層(metaPathPrefixes配下)のみ」という条件を、
// classifyRisk（issue #456で改修済み）による判定より「先に」評価し、Sweep自体を一切
// 起動しない専用ルートへ振り分ける。この条件を満たさない限り従来のisHighRiskPath/
// matchTaskKeywords/classifyRisk判定には一切影響しない（プロダクトコード向けの
// 既存TRI/RISK判定は緩めない）。理由の詳細はdocs/agents/decisions.md参照。

// 意図的に安全側に倒す（common.md TRI/RISK原則: 迷ったら高リスク側）。
// false positive（軽微なタスクが深掘りに回る＝時間コスト増）は許容し、
// false negative（高リスク変更を軽量版で見逃す）は許容しない。

// 汎用既定値。リポジトリ・スタック・ドメインに依存しない語だけを置く（共通プラグイン側の正本）。
// 'migration' は path 判定（domainKeywords）にも入れる: '<db ツール名>/migrations/' のような
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

// 後方互換用に従来のclassifyRiskもexportしたまま維持する（既存テスト・呼び出し元との互換性）。
// export は末尾でまとめる: 宣言本体を aidd-phase1-router.js のインライン複製と一字一句同じに
// 保つため（同期テストは `export ` の有無だけを正規化する。宣言ごとに export を付けても
// 動くが、末尾集約のほうが生成スクリプト（プラグイン化）での差し替えが単純になる）。
export { DEFAULT_RISK_CONFIG, resolveRiskConfig, classifyRisk, classifyRoute }
