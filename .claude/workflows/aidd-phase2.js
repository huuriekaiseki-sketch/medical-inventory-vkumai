export const meta = {
  name: 'aidd-phase2',
  description: 'Phase 3-5: contract-first並列実装 → 統合ゲート → 4観点並列検証。仕様書承認後（停止①の後）に実行。',
  whenToUse: '人間が仕様書（SPEC.md）を承認した後、Phase 3 実装に入るときに使う。aidd-1-1-deep-task.jsの後続として使う。',
  phases: [
    { title: 'Spec Check',     detail: 'SPEC.md存在チェック（欠如時は後続の全エージェントを起動せず中断）' },
    { title: 'Manifest Check', detail: 'Run Manifestのspecハッシュ突合（レビュー後のSPEC.md改変を検知）' },
    { title: 'Contract + DB', detail: 'contract-writer（型定義）とdb-impl（migrations）を並列実行' },
    { title: 'Implement',     detail: 'data-impl / api-impl / ui-impl を並列実行' },
    { title: 'Integrate',     detail: '統合ゲート：マイグレーション確認・結線・テスト・lint' },
    { title: 'Review',        detail: '4観点並列reviewer（読み取り専用）' },
  ],
}

// args: { specPath: string }
// specPath: 承認済みSPEC.mdのパス（例: "SPEC.md"。feature-specスキルはリポジトリルートに出力する）
//
// ── 前提条件（呼び出し前に人間が確認すること）──────────────────────────
// 1. SPEC.md Part 2 に以下が明記されていること
//    - 実装セット一覧（依存順）
//    - 並列グループ宣言（触るファイルを明記）
//    - data-impl が提供する関数名・シグネチャ（api-impl が参照する）
// 2. 停止①（人間承認）が完了していること
//
// ── 完了後の手順（Claude が実行すること）──────────────────────────────
// 1. 【停止②】ユーザーに /structured-review の実行を促して停止する
//    （structured-review は Claude から勝手に呼ばない）
// ────────────────────────────────────────────────────────────────────

const specPath = args?.specPath ?? 'SPEC.md'

// docs/agents/agent-result-schema.md 参照。実装/統合/レビュー系はpass/fail/blockedの3値。
// findingsはfail時の重大度分類（severity.js参照）。Sweep/Draft/Adversarial Verify
// （aidd-1-1-deep-task.js FINDING_SCHEMA）と同じcritical/important/minorを使い、
// 実装後ゲート（Contract+DB/Implement/Integrate/Review）にも重大度の概念を展開する。
const AGENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    detail: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['status', 'detail'],
}

// 重大度判定（.claude/workflows/lib/severity.js の isMinorOnlyFailure と同一発想）。
// Workflow DSLはrequire不可のためインライン複製している。ロジックの正本・テストはlib側。
function isMinorOnlyFailure(result) {
  if (result?.status !== 'fail') return false
  if (!Array.isArray(result.findings) || result.findings.length === 0) return false
  return result.findings.every(f => f?.severity === 'minor')
}

function shouldBlock(results) {
  if (results.length === 0) return false
  return !results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}

// ログ記録漏れ検知（.claude/workflows/lib/loop-observability-expectation.js の
// isLoggableAgentType と同一ロジック。Workflow DSLはrequire不可のためインライン複製）。
// reviewer/implementer/judge-panelのみ scripts/log-loop-observability.sh 呼び出し指示を
// システムプロンプトに持つ（.claude/agents/*.md参照）。この件数を「期待される記録件数」として
// 返し、フロー完了後に scripts/check-loop-observability-gap.sh で実際のログ行数と突き合わせる。
const LOGGABLE_AGENT_TYPES = new Set(['reviewer', 'implementer', 'judge-panel'])
let loggableAgentCount = 0
function countLoggable(agentType) {
  if (LOGGABLE_AGENT_TYPES.has(agentType)) loggableAgentCount++
}

// agent-progress記録漏れ検知（.claude/workflows/lib/agent-progress-expectation.js の
// isProgressLoggableAgentType と同一ロジック。Workflow DSLはrequire不可のためインライン複製）。
// docs/agents/common.md「サブエージェント進捗の可視化（issue #18）」に列挙されたagentTypeは
// scripts/log-agent-progress.sh 呼び出し指示を持つ想定。この件数を「期待される記録件数」として
// 返し、フロー完了後に scripts/check-agent-progress-gap.sh で実際のログと突き合わせる。
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set([
  'sweep-db', 'sweep-ui', 'sweep-types', 'sweep-data', 'implementer', 'reviewer',
  'integrator', 'judge-panel', 'proposer', 'adversarial-verify', 'completeness-critic', 'contract-writer',
])
let progressLoggableAgentCount = 0
function countProgressLoggable(agentType) {
  if (PROGRESS_LOGGABLE_AGENT_TYPES.has(agentType)) progressLoggableAgentCount++
}

function logMinorOnlyPassThrough(label, results) {
  const minorOnly = results.filter(isMinorOnlyFailure)
  if (minorOnly.length > 0) {
    log(`品質ゲート: ${label}でminor指摘のみのfailが${minorOnly.length}件あったが通過扱い（critical/important指摘なし）`)
  }
}

const guide = (pass, fail, blocked) => `

## 出力形式
status と detail を返すこと。
- pass: ${pass}
- fail: ${fail}
- blocked: ${blocked}

failの場合はfindings配列（{ severity: critical/important/minor, description }）で指摘ごとに
重大度を明記すること。findings全件がminorならこのゲートは通過扱いになる。
findingsを省略した場合、またはcritical/important指摘が1件でもあれば差し戻し対象になる
（severity不明・欠損はcritical扱い。fail-open防止）。`

// ─── Phase -1: Spec Check ────────────────────────────────────────────
// issue #313: 2026-07-10時点の分析で「20回のreviewer呼び出しのうち9回はSPECファイル欠如で
// 失敗し、145万トークン・$81.25を浪費した」ことが判明していた。その後の品質ゲート強化で
// SPEC欠如時はblocked判定されるようになったが、それは「まず各エージェントを起動し、
// エージェント自身がSPECファイルを読めずに気づいてblockedを自己申告する」方式のままだった。
// Workflow DSLはfilesystem APIを持たないため fs.existsSync 等は使えず、Manifest Checkと
// 同じパターン（軽量な単一エージェントによるReadツール確認）で最初にSPEC.mdの存在だけを
// 確認し、無ければ後続の全エージェント（Manifest Check以降）を一切起動せず即座に返す。
phase('Spec Check')

const SPEC_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'blocked'] },
    detail: { type: 'string' },
    actualPath: { type: 'string' },
  },
  required: ['status', 'detail', 'actualPath'],
}

const specCheck = await agent(
  `Readツールで ${specPath} が存在し読み込めるか確認してください。指定されたパス以外のファイル（例: リポジトリルート直下の別のSPEC.md）が見つかっても、それは無視して絶対に読まないでください。それ以外は何もしないでください。\n\n完了報告のactualPathフィールドに、実際にReadツールへ渡した絶対パスを（今回指定された ${specPath} をそのまま解決したもので）必ず記載してください。${guide(
    `${specPath}が存在し読み込めた`,
    '（未使用: このエージェントはpass/blockedの2値のみ返す）',
    `${specPath}が存在しない、または読み込めない`
  )}`,
  { label: 'spec-check', phase: 'Spec Check', agentType: 'reviewer', schema: SPEC_CHECK_SCHEMA }
)

countLoggable('reviewer')
countProgressLoggable('reviewer')
log(`Spec Check完了: status=${specCheck?.status ?? 'なし'}, actualPath=${specCheck?.actualPath ?? 'なし'}`)

// issue #399: Workflowツール側の非対称バグにより、最初のagent()呼び出し（Spec Check）だけが
// 指定specPathを無視しデフォルト値'SPEC.md'を対象にしてしまう事象が実測で確認されている。
// 根本原因はWorkflowツール側にある可能性が高く本スクリプトでは修正できないため、当面の防御として
// 「実際にReadした絶対パス」を自己申告させ、指定specPathとの文字列一致をここで機械検証する。
// 判定ロジックの正本・テストは .claude/workflows/lib/spec-check.js の isSpecCheckPathMismatch。
// Workflow DSLはrequire不可のためインライン複製している（プロンプト文言を変更した場合は
// spec-check.js側も手動で追従させること。自動では同期されない）。
const specCheckPathMismatch = specCheck?.status === 'pass'
  && typeof specCheck?.actualPath === 'string'
  && !specCheck.actualPath.endsWith(specPath)

if (specCheckPathMismatch) {
  log(`品質ゲート: Spec Checkが指定specPath(${specPath})ではなく別ファイル(${specCheck.actualPath})を読んだため中断（issue #399）`)
  return {
    done: false,
    specCheck,
    blocked: true,
    blockedAt: 'Spec Check',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Spec Check', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}

if (shouldBlock([specCheck])) {
  log(`品質ゲート: ${specPath}が存在しないため中断（Manifest Check以降のエージェントは起動しません）`)
  return {
    done: false,
    specCheck,
    blocked: true,
    blockedAt: 'Spec Check',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Spec Check', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}

// ─── Phase 0: Manifest Check ─────────────────────────────────────────
// issue #44/#294: docs/agents/run-manifest.md にPhase 2開始時のspecHash突合が
// 設計として定義されているが、実行コードには存在しなかった。レビュー後にSPEC.mdが
// 改変されるケースを検知できないまま実装が進んでしまう。
// Workflow DSL自体はfilesystem/Node.js APIアクセスが無いため、Read/Bashツールを持つ
// エージェントにマニフェスト読み込み・ハッシュ再計算・突合を行わせる。
// issue #316: 下記プロンプトの1〜4の判定テーブルは .claude/workflows/lib/manifest-check.js の
// classifyManifestCheck にテスト可能な形で文書化している。ただし実行パス自体はプロンプト依存の
// ままであり（Workflow DSLの制約上、実際のmanifest読込・ハッシュ計算はエージェントに委譲する
// 必要がある）、このプロンプト文言を変更した場合はmanifest-check.js側も手動で追従させること
// （自動では同期されない）。
phase('Manifest Check')

const MANIFEST_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const manifestCheck = await agent(
  `.aidd/run-manifest.json を Read ツールで読んでください（docs/agents/run-manifest.md にスキーマの説明があります）。\n\n以下を順に確認してください。\n1. .aidd/run-manifest.json が存在しない → blocked。detailに「Run Manifestが存在しません」と書く。\n2. manifest.approval（approvedBy/approvedAt）が無い → blocked。detailに「停止①の承認が記録されていません」と書く。\n3. manifest.specHash が無い → blocked。detailに「specHashが記録されていません」と書く。\n4. 上記が揃っていれば、${specPath} の現在の内容からsha256ハッシュを計算し（Bashツールで shasum -a 256 ${specPath} 等を使ってよい）、manifest.specHash と比較する。\n   - 一致すれば pass。detailに「specHash一致（承認後にSPEC.mdの変更なし）」と書く。\n   - 不一致であれば blocked。detailに「specHash不一致: レビュー承認後にSPEC.mdが変更された可能性があります（manifestの値と実際の値の両方を明記）」と書く。${guide(
    'specHashが一致し、承認記録も揃っている',
    '（未使用: このエージェントはpass/blockedの2値のみ返す）',
    'manifestが存在しない、承認記録が無い、またはspecHashが不一致'
  )}`,
  { label: 'manifest-check', phase: 'Manifest Check', agentType: 'reviewer', schema: MANIFEST_CHECK_SCHEMA }
)

countLoggable('reviewer')
countProgressLoggable('reviewer')
log(`Manifest Check完了: status=${manifestCheck?.status ?? 'なし'}`)

// 品質ゲート: deny-by-default（.claude/workflows/lib/quality-gate.js shouldBlockと同一発想）
if (manifestCheck?.status !== 'pass') {
  log(`品質ゲート: Run Manifestのspec Hash突合に失敗したため中断（${manifestCheck?.detail ?? '詳細不明'}）`)
  return {
    done: false,
    manifestCheck,
    blocked: true,
    blockedAt: 'Manifest Check',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Manifest Check', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}

// ─── Phase A: Contract Write + DB（並列）─────────────────────────────
// contract-writer: src/types/ の型定義を確定（implementerの「契約」）
// db-impl: supabase/migrations/ を実装（SPEC.mdから直接、contract-writerと並行）
phase('Contract + DB')

const [contractResult, dbResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに src/types/ の型定義・APIインターフェース型を確定させてください。${guide(
      '型定義・APIインターフェース型を確定できた',
      '型定義を試みたが不完全・矛盾がある',
      'SPEC.mdが存在しない/読めない'
    )}`,
    { label: 'contract-writer', phase: 'Contract + DB', agentType: 'contract-writer', schema: AGENT_RESULT_SCHEMA }
  ),
  // db-implプロンプトの正本は .claude/workflows/lib/prompts/db-impl.js（buildDbImplPrompt）。
  // Workflow DSLはrequire不可のためここに同一内容をインライン複製している。
  // 一字一句の同期は .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js が検証する
  // （npm testに含まれる。乖離時は即座にテスト失敗する。issue #391）。
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。\nPart 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。\nDBスキーマ変更が必要そうだが、対象テーブル名・カラム設計・facilityスコープ（RLS）等をPart2や既存の型契約（src/types/）から安全に確定できない場合も、推測でマイグレーションを実装しようとせずstatus: blockedで不足している情報を具体的に書いて報告すること。これはfail（実装エラー・矛盾）ではなくblocked（着手に必要な情報が足りない）として扱う。${guide(
      'マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した',
      'マイグレーションの実装を試みたがSQLの構文誤り・既存スキーマとの矛盾等の実装エラーが生じた',
      'SPEC.mdが存在しない、Part2にDB変更の要否自体を判断できる記載が無い、またはDB変更は必要そうだが対象テーブル・カラム設計・facilityスコープを安全に確定できるだけの情報が無い'
    )}`,
    { label: 'db-impl', phase: 'Contract + DB', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
])

countLoggable('contract-writer')
countLoggable('implementer')
countProgressLoggable('contract-writer')
countProgressLoggable('implementer')
log('Contract + DB完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// deny-by-default: 全員がpass（またはfindings全件minorのfail）でない限り止める
// （fail/blockedはもちろんnull・未知の値も止める。issue #289）
if (shouldBlock([contractResult, dbResult])) {
  log('品質ゲート: Contract + DBでfail/blockedを検知したため中断（Implement以降へは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    blocked: true,
    blockedAt: 'Contract + DB',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Contract + DB', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}
logMinorOnlyPassThrough('Contract + DB', [contractResult, dbResult])

// ─── Phase B: data / api / ui（並列）─────────────────────────────────
// 3グループは contract-writer の出力（src/types/）を契約として参照する
// api-impl は SPEC.md Part 2 記載の関数シグネチャに従って呼び出すだけ（data-impl の完了を待たない）
// db-impl の完了報告も渡す（スキーマ変更があった場合に追従できるよう）
phase('Implement')

const implGuide = guide(
  '担当範囲の実装を完了できた',
  '実装したが明らかに不完全、またはcontract-writer/db-implの結果と矛盾する',
  'SPEC.mdが見つからない、またはcontract-writer/db-implの完了報告が空で着手できなかった'
)

const [dataResult, apiResult, uiResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/lib/supabase/ のデータアクセス関数を実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/lib/supabase/ と src/lib/*/repository.ts。\n\n## contract-writer完了報告\n${contractResult?.detail}\n\n## db-impl完了報告\n${dbResult?.detail}${implGuide}`,
    { label: 'data-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/**/route.ts（/api配下に限らない）を実装してください。\n型定義（src/types/）は確定済みです。\nPart 2 に記載の関数シグネチャに従って src/lib/ の関数を呼ぶこと（実装がまだでも名前・型が確定していれば前進可）。\n触ってよいファイル: src/app/**/route.ts のみ。\n\n## contract-writer完了報告\n${contractResult?.detail}\n\n## db-impl完了報告\n${dbResult?.detail}${implGuide}`,
    { label: 'api-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/(pages)/ と src/components/ のUIを実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/app/(pages)/ と src/components/ のみ。\n\n## contract-writer完了報告\n${contractResult?.detail}${implGuide}`,
    { label: 'ui-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
])

countLoggable('implementer')
countLoggable('implementer')
countLoggable('implementer')
countProgressLoggable('implementer')
countProgressLoggable('implementer')
countProgressLoggable('implementer')
log('Implement完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック（deny-by-default）
if (shouldBlock([dataResult, apiResult, uiResult])) {
  log('品質ゲート: Implementでfail/blockedを検知したため中断（統合ゲートへは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    blocked: true,
    blockedAt: 'Implement',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Implement', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}
logMinorOnlyPassThrough('Implement', [dataResult, apiResult, uiResult])

// ─── Phase C: 統合ゲート ──────────────────────────────────────────────
// issue #316: 手順7のchangedFiles上書き（「他フィールドは変更しないこと」）は
// .claude/workflows/lib/manifest-check.js の applyChangedFiles にテスト可能な形で
// 文書化している。こちらもプロンプト依存の実行パス自体は変わらない（上記Manifest Check参照）。
phase('Integrate')

const integrationResult = await agent(
  `並列実装が完了しました。以下の順で作業してください。\n0. まずReadツールで ${specPath} が存在するか確認する。存在しない場合、または下記の完了報告のいずれかに「仕様書が見つからない」「作業を開始できない」等の記述がある場合は、それを最優先の異常事態として報告の先頭に明記すること（該当implエージェントは未着手として扱い、テスト・lintが緑でも全体を正常完了と報告しないこと）。\n1. マイグレーションが適用済みか確認する（未適用ならSupabase CLIで適用する）\n2. 各implementerの成果を結線し、共有ファイルを編集する\n3. npm test を実行 → 失敗があれば修正（3回まで）\n4. npm run lint を実行 → 失敗があれば修正\n5. npx tsc --noEmit を実行 → 型エラーがあれば修正（3回まで。issue #46のDONE基準に型検査を含める）\n6. 全テスト・lint・tsc緑を確認して報告\n7. .aidd/run-manifest.json をReadツールで読み、manifest.baseCommitを取得する（無ければこのステップはスキップしてよい）。取得できた場合、Bashツールで \`git diff --name-only \${baseCommit}\`（baseCommitはmanifestの値に置き換える）を実行し、変更されたファイル一覧を取得する。取得できたら .aidd/run-manifest.json の changedFiles フィールドをその一覧で上書きし、Writeツールで保存する（docs/agents/run-manifest.md 参照。他フィールドは変更しないこと）。\n\n## 各完了報告\n### contract-writer\n${contractResult?.detail}\n### db-impl\n${dbResult?.detail}\n### data-impl\n${dataResult?.detail}\n### api-impl\n${apiResult?.detail}\n### ui-impl\n${uiResult?.detail}${guide(
    'npm test・npm run lint・npx tsc --noEmitが最終的に全て緑で統合完了',
    '3回の修正試行後もtest/lint/tscのいずれかが赤のまま',
    'SPEC.mdが見つからない、またはいずれかのimplエージェントの完了報告に「仕様書が見つからない」「作業を開始できない」旨の記述がある'
  )}`,
  { label: 'integrator', phase: 'Integrate', agentType: 'integrator', schema: AGENT_RESULT_SCHEMA }
)

countLoggable('integrator')
countProgressLoggable('integrator')
log('統合完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック（deny-by-default）
if (shouldBlock([integrationResult])) {
  log('品質ゲート: Integrateでfail/blockedを検知したため中断（Reviewへは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    integration: integrationResult,
    blocked: true,
    blockedAt: 'Integrate',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Integrate', expectedLoopObservabilityRecords: loggableAgentCount, expectedAgentProgressRecords: progressLoggableAgentCount },
  }
}
logMinorOnlyPassThrough('Integrate', [integrationResult])

// ─── Phase D: 4観点並列レビュー（fail時はImplementerへ差し戻す修正ループ、最大3回）──
// issue #45/#292: 従来はReviewのstatus(fail)を一切見ずdetailのみ使い、指摘があっても
// 後続に何も反映されず「検証完了」として終わっていた。fail検出時はImplementerへ
// 差し戻して再修正させ、再度4観点レビューし直す。最大3回再試行し、それでもfailが
// 残る場合はblockedとして人間（停止②の構造化レビュー）に引き渡す。
// 判定ロジック: .claude/workflows/lib/review-retry.js の classifyReviewRound と同一
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// 重大度分類: findings全件がminorの指摘だけでは差し戻さない（UIの軽微な指摘で修正ループを
// 回さない。DB/ロジックのcritical/important指摘は従来通り差し戻し対象）
phase('Review')

const REVIEW_DIMENSIONS = [
  { key: 'correctness', label: '正しさ（バグ・境界条件）' },
  { key: 'coverage',    label: '仕様カバレッジ（受け入れ条件 vs 実装・テスト）' },
  { key: 'redundancy',  label: '重複・過剰実装・抜け漏れ' },
  { key: 'type-safety', label: '型安全・データ層の整合' },
]

const reviewGuide = guide(
  'レビューを完了し指摘なし',
  'レビューを完了し1件以上の指摘がある',
  'レビュー対象のコード・SPEC.mdが見つからずレビュー自体ができなかった'
)

// issue #314: blockedの観点はImplementerへの差し戻しでは解決しない（レビュー対象自体が
// 見つからない等）ため、fail判定より先に見て即座に打ち切る。従来はblockedのみの回を
// done=true,blocked=falseとして素通りしており、最終returnにblockedAtが付かず追跡できなかった。
function classifyReviewRound(results, dimensions, attempt, maxRetries) {
  const blockedDimensions = dimensions
    .map((dim, i) => ({ dim, result: results[i] }))
    .filter(({ result }) => result?.status === 'blocked')
  if (blockedDimensions.length > 0) return { done: true, blocked: true, failingDimensions: [], blockedDimensions }

  const failingDimensions = dimensions
    .map((dim, i) => ({ dim, result: results[i] }))
    .filter(({ result }) => result?.status === 'fail' && !isMinorOnlyFailure(result))
  if (failingDimensions.length === 0) return { done: true, blocked: false, failingDimensions: [], blockedDimensions: [] }
  if (attempt > maxRetries) return { done: true, blocked: true, failingDimensions, blockedDimensions: [] }
  return { done: false, blocked: false, failingDimensions, blockedDimensions: [] }
}

const MAX_REVIEW_RETRIES = 3
let reviewResults
let reviewAttempt = 0
let reviewRetryAgentCount = 0

while (true) {
  reviewAttempt++
  log(`Reviewラウンド ${reviewAttempt}/${MAX_REVIEW_RETRIES + 1} 開始`)

  reviewResults = await parallel(
    REVIEW_DIMENSIONS.map(dim => () => agent(
      `まず ${specPath} を Read ツールで読んでください。\n観点「${dim.label}」の視点のみでレビューしてください。\n指摘のみを箇条書きで返す。修正はしない。問題なければ「指摘なし」と返す。${reviewGuide}`,
      { label: `review:${dim.key}:R${reviewAttempt}`, agentType: 'reviewer', phase: 'Review', schema: AGENT_RESULT_SCHEMA }
    ))
  )

  REVIEW_DIMENSIONS.forEach(() => countLoggable('reviewer'))
  REVIEW_DIMENSIONS.forEach(() => countProgressLoggable('reviewer'))

  const { done, blocked, failingDimensions, blockedDimensions } = classifyReviewRound(reviewResults, REVIEW_DIMENSIONS, reviewAttempt, MAX_REVIEW_RETRIES)

  if (done && !blocked) {
    log(`Review完了: ラウンド${reviewAttempt}で全観点pass（指摘なし）`)
    logMinorOnlyPassThrough('Review', reviewResults)
    break
  }

  if (blocked) {
    const reason = blockedDimensions.length > 0
      ? `${blockedDimensions.length}件の観点でレビュー自体が実行できなかった（blocked）ため`
      : `${MAX_REVIEW_RETRIES}回の差し戻し後もfailが残るため`
    log(`品質ゲート: Reviewで${reason}中断（blockedとして人間に引き渡します）`)
    return {
      done: false,
      contractResult,
      dbResult,
      dataResult,
      apiResult,
      uiResult,
      integration: integrationResult,
      reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
        dimension: dim.label,
        findings:  reviewResults[i]?.detail ?? '指摘なし',
      })),
      blocked: true,
      blockedAt: 'Review',
      stats: {
        phase: 'phase2',
        done: false,
        blocked: true,
        blockedAt: 'Review',
        reviewBlockedDimensions: blockedDimensions.length,
        reviewRetries: reviewRetryAgentCount,
        expectedLoopObservabilityRecords: loggableAgentCount,
        expectedAgentProgressRecords: progressLoggableAgentCount,
      },
    }
  }

  log(`Review: ${failingDimensions.length}件の観点でfailを検知（試行${reviewAttempt}/${MAX_REVIEW_RETRIES + 1}）→ Implementerへ差し戻します`)

  const retryFindings = failingDimensions
    .map(({ dim, result }) => `## ${dim.label}\n${result.detail}`)
    .join('\n\n')

  await agent(
    `まず ${specPath} を Read ツールで読んでください。\n以下はコードレビューで検出された指摘です。該当箇所を修正してください（修正のみ、レビューはしない）。\n\n${retryFindings}${guide(
      '指摘箇所をすべて修正できた',
      '修正を試みたが解決できない指摘が残る',
      '指摘内容から修正対象・該当ファイルが特定できない'
    )}`,
    { label: `implementer-retry:R${reviewAttempt}`, phase: 'Review', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  )
  countLoggable('implementer')
  countProgressLoggable('implementer')
  reviewRetryAgentCount++
}

const implResults = [contractResult, dbResult, dataResult, apiResult, uiResult]

// DONE判定: .claude/workflows/lib/phase2-done.js の computeDone と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// issue #46: 修正ループ（Review差し戻し等）を実装しても、最終的な完了条件(DONE)が
// 明示されていないと「いつ止まっていいか」が曖昧になる。DONE = 全実装がpass（またはfindings
// 全件minorのfail） AND 統合ゲート(test/lint/tsc)がpass AND 全観点Reviewがpass AND
// specHashが一致、のすべてを満たした場合のみtrueにする。
function allPass(results) {
  return results.length > 0 && results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}
const done =
  allPass(implResults) &&
  integrationResult?.status === 'pass' &&
  allPass(reviewResults) &&
  manifestCheck?.status === 'pass'

log(`検証完了（DONE=${done}）。/structured-review でレビュー結果を確認してください。`)

return {
  done,
  manifestCheck,
  contractResult,
  dbResult,
  dataResult,
  apiResult,
  uiResult,
  integration:  integrationResult,
  reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
    dimension: dim.label,
    findings:  reviewResults[i]?.detail ?? '指摘なし',
  })),
  stats: {
    phase: 'phase2',
    done,
    implAgents: 5,
    reviewAgents: REVIEW_DIMENSIONS.length,
    reviewRetries: reviewRetryAgentCount,
    totalAgents: 1 + 5 + 1 + REVIEW_DIMENSIONS.length + reviewRetryAgentCount,
    implSuccessCount: implResults.filter(r => r?.status === 'pass').length,
    implBlockedCount: implResults.filter(r => r?.status === 'blocked').length,
    expectedLoopObservabilityRecords: loggableAgentCount,
    expectedAgentProgressRecords: progressLoggableAgentCount,
  },
}
