// AIDD パイプラインのグラフマニフェスト（issue #710）。
//
// WHY: 配線（どのノードが・どの条件で・どこへ進み・blocked になったら誰に戻るか）は
//      これまで aidd-*.js（合計 1,600 行超）の制御フローに散在し、図 docs/aidd-pipeline.html は
//      手描きで同期テストが無かった。グラフエンジニアリングの推奨どおり、トポロジーを
//      「バージョン管理された明示的成果物」にし、
//        - .claude/workflows/lib/__tests__/graph-manifest-sync.test.js が JS 実装との一致を
//          npm test で検査（phase 名・agentType・blockedAt・予算定数・fan-out 数）
//        - scripts/lib/render-aidd-graph.mjs が docs/aidd-pipeline.html と
//          docs/agents/aidd-graph.md（Mermaid）を生成（手編集禁止。鮮度は
//          scripts/check-aidd-graph-rendered.test.sh が CI で検査）
//      する。実行エンジン（LangGraph 等）は導入しない。Workflow DSL のままで、本ファイルは
//      「読める配線図＋ドリフト検知」に留める（docs/agents/decisions/aidd-pipeline.md）。
//
// スキーマ:
//   humanGates: 人間が判断する停止点。blocked エッジの returnsTo から参照される
//   workflows[<name>]:
//     file      実装ファイル（.claude/workflows/ 相対）
//     pattern   Anthropic「Building effective agents」の分類（後任が構造を掴むための注記）
//     budgets   JS 側の定数と一致させる数値（同期テスト対象）
//     nodes[]   { id, phase, kind, label, agentType?, model?, effort?, fanout?, parallelGroup?, veto? }
//               kind: agent（LLM 呼び出し）/ code（決定的コード）/ gate（品質ゲート・拒否権）/
//                     workflow（子 Workflow 起動）/ end（戻り値）
//               model/effort は Workflow 側のインライン指定。agentType 経由の呼び出しは
//               frontmatter が効く（docs/ai-config-map.md「effort/model指定がどの実行経路に効くか」）
//     edges[]   { from, to, on, blockedAt?, returnsTo?, note? }
//               on: pass / fail / blocked / minor-only / retry / token-cap / loop / route:<x> / always
//               blockedAt: JS の blockedAt 文字列（同期テスト対象）。必ず returnsTo を持つ
//               returnsTo: humanGates のキー、または 'human'（オーケストレーターが detail を読んで
//                          判断）/ 'resumeFromRunId'（docs/agents/workflow-resume-runbook.md）

export const HUMAN_GATES = {
  'stop-1': {
    label: '停止①（仕様レビュー）',
    description: 'SPEC.md Part 1 を人間が承認し、.aidd/run-manifest.json に approval と specHash を記録するまで Phase 3 へ進まない',
    reenter: 'aidd-phase2',
  },
  'stop-2': {
    label: '停止②（構造化レビュー）',
    description: '/structured-review を人間が起動するまで勝手に実行しない。Review で blocked / 3 回差し戻しても fail が残る場合はここへ引き渡す',
    reenter: null,
  },
}

export const WORKFLOWS = {
  'aidd-phase1-router': {
    file: 'aidd-phase1-router.js',
    pattern: 'routing',
    budgets: {},
    nodes: [
      { id: 'route', phase: 'Route', kind: 'code', label: 'classifyRoute（TRI/RISK・メタ改修判定。正本 lib/router-risk.js）', veto: true },
      { id: 'meta-end', phase: 'Route', kind: 'end', label: 'aidd-phase1-meta（Sweep をスキップして設計検討へ）' },
      { id: 'confirm-end', phase: 'Route', kind: 'end', label: 'aidd-phase1-needs-confirmation（人間が deep / light を選ぶ）' },
      { id: 'deep', phase: 'Route', kind: 'workflow', label: 'workflow(aidd-1-1-deep-task)' },
      { id: 'light', phase: 'Route', kind: 'workflow', label: 'workflow(aidd-phase1)' },
    ],
    edges: [
      { from: 'route', to: 'meta-end', on: 'route:meta', note: '.claude/workflows/・.claude/agents/・docs/agents/ 配下のみの変更' },
      { from: 'route', to: 'confirm-end', on: 'route:confirm', returnsTo: 'human', note: 'changedFiles 空でキーワードのみ一致（issue #500）' },
      { from: 'route', to: 'deep', on: 'route:deep', note: '高リスクパス・ドメイン語に一致' },
      { from: 'route', to: 'light', on: 'route:light' },
    ],
  },

  'aidd-phase1': {
    file: 'aidd-phase1.js',
    pattern: 'parallelization',
    budgets: {},
    nodes: [
      { id: 'sweep-ui', phase: 'Sweep', kind: 'agent', label: 'sweep-ui', agentType: 'sweep-ui', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-data', phase: 'Sweep', kind: 'agent', label: 'sweep-data', agentType: 'sweep-data', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-db', phase: 'Sweep', kind: 'agent', label: 'sweep-db', agentType: 'sweep-db', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-types', phase: 'Sweep', kind: 'agent', label: 'sweep-types', agentType: 'sweep-types', effort: 'low', parallelGroup: 'sweep' },
      { id: 'capture-base-commit', phase: 'Sweep', kind: 'agent', label: 'capture-base-commit（providedBaseCommit 無しのときのみ）', effort: 'low', parallelGroup: 'sweep' },
      { id: 'classify', phase: 'Sweep', kind: 'gate', label: 'classifyPhase1Results（4 軸すべて null なら throw）', veto: true },
      { id: 'end', phase: 'Sweep', kind: 'end', label: 'findings + runManifestSeed → Phase 2（feature-spec）→ 停止①' },
    ],
    edges: [
      { from: 'sweep-ui', to: 'classify', on: 'always' },
      { from: 'sweep-data', to: 'classify', on: 'always' },
      { from: 'sweep-db', to: 'classify', on: 'always' },
      { from: 'sweep-types', to: 'classify', on: 'always' },
      { from: 'classify', to: 'end', on: 'pass' },
      { from: 'classify', to: 'end', on: 'fail', returnsTo: 'human', note: '全 4 軸が agent() 失敗（null）→ throw。手動で再実行' },
    ],
  },

  'aidd-1-1-deep-task': {
    file: 'aidd-1-1-deep-task.js',
    pattern: 'orchestrator-workers + evaluator-optimizer（Loop Until Dry）',
    budgets: {
      DEFAULT_TOKEN_CAP: 2_000_000,
      MIN_BUDGET_FOR_SWEEP_ROUND: 400_000,
      maxRoundsDefault: 3,
      dryRoundsToConverge: 2,
      finders: 5,
      proposers: 3,
      scoreLenses: 3,
    },
    nodes: [
      { id: 'sweep-ui', phase: 'Sweep', kind: 'agent', label: 'sweep-ui（focused）', agentType: 'sweep-ui', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-data', phase: 'Sweep', kind: 'agent', label: 'sweep-data（focused）', agentType: 'sweep-data', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-db', phase: 'Sweep', kind: 'agent', label: 'sweep-db（focused）', agentType: 'sweep-db', effort: 'low', parallelGroup: 'sweep' },
      { id: 'sweep-types', phase: 'Sweep', kind: 'agent', label: 'sweep-types（focused）', agentType: 'sweep-types', effort: 'low', parallelGroup: 'sweep' },
      { id: 'critic', phase: 'Completeness Critic', kind: 'agent', label: 'completeness-critic（ラウンド末）', agentType: 'completeness-critic' },
      { id: 'loop', phase: 'Completeness Critic', kind: 'gate', label: 'shouldContinueSweepLoop（dry 2 回で収束 / maxRounds / budget / token cap）', veto: true },
      { id: 'draft', phase: 'Draft Spec', kind: 'agent', label: 'draft-spec', model: 'sonnet', effort: 'medium' },
      { id: 'draft-gate', phase: 'Draft Spec', kind: 'gate', label: 'draftSpec.status === pass（deny-by-default）', veto: true },
      { id: 'find', phase: 'Find', kind: 'agent', label: 'find:<lens>（logic/data/security/ux/performance）', model: 'haiku', effort: 'low', fanout: 5, parallelGroup: 'find' },
      { id: 'verify', phase: 'Adversarial Verify', kind: 'agent', label: 'verify:<i>（critical/important の指摘ごと。minor は自動生存）', model: 'opus', effort: 'medium', fanout: 'findings', parallelGroup: 'verify' },
      { id: 'critic2', phase: 'Completeness Critic', kind: 'agent', label: 'completeness-critic-2（インライン指定。frontmatter は効かない）', model: 'sonnet', effort: 'medium' },
      { id: 'propose', phase: 'Judge Panel', kind: 'agent', label: 'propose:<stance>（MVP優先/リスク最小/拡張性重視）', model: 'sonnet', effort: 'medium', fanout: 3, parallelGroup: 'propose' },
      { id: 'divergence', phase: 'Judge Panel', kind: 'code', label: 'computeDivergence（bigram Jaccard ≥ 0.5 で分岐判定。正本 lib/judge-panel.js）' },
      { id: 'score', phase: 'Judge Panel', kind: 'agent', label: 'score:<案>:<lens>（correctness/security/ux。分岐ありのときのみ）', model: 'haiku', effort: 'low', fanout: 9, parallelGroup: 'score' },
      { id: 'synthesize', phase: 'Synthesize', kind: 'agent', label: 'synthesize', model: 'sonnet', effort: 'high' },
      { id: 'end', phase: 'Synthesize', kind: 'end', label: 'synthesis（仕様書ドラフトへの修正提案）→ Phase 2（feature-spec）→ 停止①' },
    ],
    edges: [
      { from: 'sweep-ui', to: 'critic', on: 'always' },
      { from: 'sweep-data', to: 'critic', on: 'always' },
      { from: 'sweep-db', to: 'critic', on: 'always' },
      { from: 'sweep-types', to: 'critic', on: 'always' },
      { from: 'critic', to: 'loop', on: 'always' },
      { from: 'loop', to: 'sweep-ui', on: 'loop', note: '新規指摘または Critic の追加調査対象があれば次ラウンド' },
      { from: 'loop', to: 'draft', on: 'pass', note: '収束 / ラウンド上限 / budget 不足 / token cap のいずれでも Draft Spec へ進む（未完了は log で区別）' },
      { from: 'draft', to: 'draft-gate', on: 'always' },
      { from: 'draft-gate', to: 'find', on: 'pass' },
      { from: 'draft-gate', to: 'end', on: 'blocked', blockedAt: 'Draft Spec', returnsTo: 'human', note: 'fail / blocked / null はすべて中断。taskDescription・maxRounds を見直して再実行' },
      { from: 'draft-gate', to: 'end', on: 'token-cap', blockedAt: 'Token Cap (before Find)', returnsTo: 'resumeFromRunId' },
      { from: 'find', to: 'verify', on: 'pass', note: 'dedup 後の critical/important のみ verify' },
      { from: 'find', to: 'end', on: 'token-cap', blockedAt: 'Token Cap (before Adversarial Verify)', returnsTo: 'resumeFromRunId' },
      { from: 'verify', to: 'critic2', on: 'always' },
      { from: 'critic2', to: 'propose', on: 'always' },
      { from: 'propose', to: 'divergence', on: 'always' },
      { from: 'divergence', to: 'score', on: 'pass', note: '分岐あり（divergenceRatio ≥ 0.5）' },
      { from: 'divergence', to: 'synthesize', on: 'fail', note: '分岐なし → 採点を省略し先頭案を採用' },
      { from: 'score', to: 'synthesize', on: 'always' },
      { from: 'synthesize', to: 'end', on: 'always' },
    ],
  },

  'aidd-phase2': {
    file: 'aidd-phase2.js',
    pattern: 'prompt chaining + parallelization + evaluator-optimizer（Review 差し戻し）',
    budgets: {
      DEFAULT_TOKEN_CAP: 2_500_000,
      MAX_REVIEW_RETRIES: 3,
      reviewDimensions: 4,
    },
    nodes: [
      { id: 'spec-check', phase: 'Spec Check', kind: 'gate', label: 'spec-check（SPEC.md の実在・Part 2 の有無）', agentType: 'reviewer', veto: true },
      { id: 'manifest-check', phase: 'Manifest Check', kind: 'gate', label: 'manifest-check（run-manifest の approval / specHash 突合）', agentType: 'reviewer', veto: true },
      { id: 'contract-writer', phase: 'Contract + DB', kind: 'agent', label: 'contract-writer（src/types/）', agentType: 'contract-writer', parallelGroup: 'contract-db' },
      { id: 'db-impl', phase: 'Contract + DB', kind: 'agent', label: 'db-impl（supabase/migrations/）', agentType: 'implementer', parallelGroup: 'contract-db' },
      { id: 'gate-contract-db', phase: 'Contract + DB', kind: 'gate', label: 'shouldBlock（fail/blocked/null → 中断。minor のみの fail は通す）', veto: true },
      { id: 'data-impl', phase: 'Implement', kind: 'agent', label: 'data-impl', agentType: 'implementer', parallelGroup: 'implement' },
      { id: 'api-impl', phase: 'Implement', kind: 'agent', label: 'api-impl', agentType: 'implementer', parallelGroup: 'implement' },
      { id: 'ui-impl', phase: 'Implement', kind: 'agent', label: 'ui-impl', agentType: 'implementer', parallelGroup: 'implement' },
      { id: 'gate-implement', phase: 'Implement', kind: 'gate', label: 'shouldBlock', veto: true },
      { id: 'coverage-check', phase: 'Coverage Check', kind: 'gate', label: 'coverage-check（baseCommit からの変更ファイル有無）', agentType: 'reviewer' },
      { id: 'group-implementer', phase: 'Coverage Check', kind: 'agent', label: 'group-implementer（5 ロール全員が担当外だったときのみ）', agentType: 'implementer' },
      { id: 'gate-coverage', phase: 'Coverage Check', kind: 'gate', label: 'shouldBlock（group-implementer の結果）', veto: true },
      { id: 'integrator', phase: 'Integrate', kind: 'agent', label: 'integrator（結線 + npm test / lint / tsc、各 3 回まで修正）', agentType: 'integrator' },
      { id: 'gate-integrate', phase: 'Integrate', kind: 'gate', label: 'shouldBlock', veto: true },
      { id: 'review', phase: 'Review', kind: 'agent', label: 'review:<dim>（correctness/coverage/redundancy/type-safety）', agentType: 'reviewer', fanout: 4, parallelGroup: 'review' },
      { id: 'classify-review', phase: 'Review', kind: 'gate', label: 'classifyReviewRound（正本 lib/review-retry.js）', veto: true },
      { id: 'implementer-retry', phase: 'Review', kind: 'agent', label: 'implementer-retry:R<n>（直近 2 attempt の履歴付き）', agentType: 'implementer' },
      { id: 'end', phase: 'Review', kind: 'end', label: 'DONE（computeDone: 全 impl pass ∧ integrate pass ∧ 全 review pass ∧ specHash 一致）→ 停止②' },
    ],
    edges: [
      { from: 'spec-check', to: 'manifest-check', on: 'pass' },
      { from: 'spec-check', to: 'end', on: 'blocked', blockedAt: 'Spec Check', returnsTo: 'stop-1', note: 'SPEC.md が無い / Part 2 が無い。specPath（絶対パス）を直して再実行' },
      { from: 'manifest-check', to: 'contract-writer', on: 'pass' },
      { from: 'manifest-check', to: 'end', on: 'blocked', blockedAt: 'Manifest Check', returnsTo: 'stop-1', note: 'approval 未記録 / specHash 不一致。停止①をやり直す' },
      { from: 'manifest-check', to: 'end', on: 'token-cap', blockedAt: 'Token Cap (before Contract + DB)', returnsTo: 'resumeFromRunId' },
      { from: 'contract-writer', to: 'gate-contract-db', on: 'always' },
      { from: 'db-impl', to: 'gate-contract-db', on: 'always' },
      { from: 'gate-contract-db', to: 'data-impl', on: 'pass' },
      { from: 'gate-contract-db', to: 'data-impl', on: 'minor-only', note: 'findings 全件 minor の fail は通す（logMinorOnlyPassThrough）' },
      { from: 'gate-contract-db', to: 'end', on: 'blocked', blockedAt: 'Contract + DB', returnsTo: 'human', note: 'detail を読み、SPEC 修正（→停止①）か再実行かを判断' },
      { from: 'gate-contract-db', to: 'end', on: 'token-cap', blockedAt: 'Token Cap (before Implement)', returnsTo: 'resumeFromRunId' },
      { from: 'data-impl', to: 'gate-implement', on: 'always' },
      { from: 'api-impl', to: 'gate-implement', on: 'always' },
      { from: 'ui-impl', to: 'gate-implement', on: 'always' },
      { from: 'gate-implement', to: 'coverage-check', on: 'pass' },
      { from: 'gate-implement', to: 'end', on: 'blocked', blockedAt: 'Implement', returnsTo: 'human' },
      { from: 'coverage-check', to: 'integrator', on: 'pass', note: 'hasChanges: true、または baseCommit 不明（blocked = 判定スキップ）' },
      { from: 'coverage-check', to: 'group-implementer', on: 'fail', note: 'hasChanges: false（5 ロール全員が担当外）' },
      { from: 'group-implementer', to: 'gate-coverage', on: 'always' },
      { from: 'gate-coverage', to: 'integrator', on: 'pass' },
      { from: 'gate-coverage', to: 'end', on: 'blocked', blockedAt: 'Coverage Check', returnsTo: 'human' },
      { from: 'integrator', to: 'gate-integrate', on: 'always' },
      { from: 'gate-integrate', to: 'review', on: 'pass' },
      { from: 'gate-integrate', to: 'end', on: 'blocked', blockedAt: 'Integrate', returnsTo: 'human', note: '3 回修正しても test/lint/tsc が赤' },
      { from: 'gate-integrate', to: 'end', on: 'token-cap', blockedAt: 'Token Cap (before Review)', returnsTo: 'resumeFromRunId', note: 'Review ループの各ラウンド先頭で判定' },
      { from: 'review', to: 'classify-review', on: 'always' },
      { from: 'classify-review', to: 'end', on: 'pass', note: '全観点 pass → DONE' },
      { from: 'classify-review', to: 'implementer-retry', on: 'retry', note: 'fail あり ∧ attempt ≤ MAX_REVIEW_RETRIES' },
      { from: 'implementer-retry', to: 'review', on: 'loop' },
      { from: 'classify-review', to: 'end', on: 'blocked', blockedAt: 'Review', returnsTo: 'stop-2', note: 'レビュー自体ができない観点がある、または 3 回差し戻しても fail が残る' },
    ],
  },
}

export const GRAPH = { version: 1, humanGates: HUMAN_GATES, workflows: WORKFLOWS }
export default GRAPH
