<!-- GENERATED FILE — DO NOT EDIT. Source: .claude/workflows/graph/aidd-graph.mjs. Regenerate: node scripts/lib/render-aidd-graph.mjs (issue #710) -->
# AIDD パイプライン配線図（生成物）

正本は `.claude/workflows/graph/aidd-graph.mjs`。このファイルと `docs/aidd-pipeline.html` は
`node scripts/lib/render-aidd-graph.mjs` で生成する（手編集禁止。鮮度は
`scripts/check-aidd-graph-rendered.test.sh` が検査）。マニフェストと各 Workflow DSL の一致は
`.claude/workflows/lib/__tests__/graph-manifest-sync.test.js` が `npm test` で検査する（issue #710）。

## 人間ゲート

- **停止①（仕様レビュー）**（`stop-1`）: SPEC.md Part 1 を人間が承認し、.aidd/run-manifest.json に approval と specHash を記録するまで Phase 3 へ進まない（再開: `aidd-phase2`）
- **停止②（構造化レビュー）**（`stop-2`）: /structured-review を人間が起動するまで勝手に実行しない。Review で blocked / 3 回差し戻しても fail が残る場合はここへ引き渡す

## aidd-phase1-router（`aidd-phase1-router.js`）

パターン: routing


```mermaid
flowchart TD
  route[["Route: route"]]
  meta-end(["Route: meta-end"])
  confirm-end(["Route: confirm-end"])
  deep[["Route: deep"]]
  light[["Route: light"]]
  route -->|"route:meta"| meta-end
  route -->|"route:confirm"| confirm-end
  route -->|"route:deep"| deep
  route -->|"route:light"| light
```

## aidd-phase1（`aidd-phase1.js`）

パターン: parallelization


```mermaid
flowchart TD
  sweep-ui["Sweep: sweep-ui"]
  sweep-data["Sweep: sweep-data"]
  sweep-db["Sweep: sweep-db"]
  sweep-types["Sweep: sweep-types"]
  capture-base-commit["Sweep: capture-base-commit"]
  classify{{"Sweep: classify"}}
  end_(["Sweep: end"])
  sweep-ui -->|"always"| classify
  sweep-data -->|"always"| classify
  sweep-db -->|"always"| classify
  sweep-types -->|"always"| classify
  classify -->|"pass"| end_
  classify -->|"fail"| end_
```

## aidd-1-1-deep-task（`aidd-1-1-deep-task.js`）

パターン: orchestrator-workers + evaluator-optimizer（Loop Until Dry）

予算・上限:
- `DEFAULT_TOKEN_CAP` = 2,000,000
- `MIN_BUDGET_FOR_SWEEP_ROUND` = 400,000
- `maxRoundsDefault` = 3
- `dryRoundsToConverge` = 2
- `finders` = 5
- `proposers` = 3
- `scoreLenses` = 3

```mermaid
flowchart TD
  sweep-ui["Sweep: sweep-ui"]
  sweep-data["Sweep: sweep-data"]
  sweep-db["Sweep: sweep-db"]
  sweep-types["Sweep: sweep-types"]
  critic["Completeness Critic: critic"]
  loop{{"Completeness Critic: loop"}}
  draft["Draft Spec: draft"]
  draft-gate{{"Draft Spec: draft-gate"}}
  find["Find: find"]
  verify["Adversarial Verify: verify"]
  critic2["Completeness Critic: critic2"]
  propose["Judge Panel: propose"]
  divergence[["Judge Panel: divergence"]]
  score["Judge Panel: score"]
  synthesize["Synthesize: synthesize"]
  end_(["Synthesize: end"])
  sweep-ui -->|"always"| critic
  sweep-data -->|"always"| critic
  sweep-db -->|"always"| critic
  sweep-types -->|"always"| critic
  critic -->|"always"| loop
  loop -->|"loop"| sweep-ui
  loop -->|"pass"| draft
  draft -->|"always"| draft-gate
  draft-gate -->|"pass"| find
  draft-gate -->|"blocked: Draft Spec → human"| end_
  draft-gate -->|"token-cap: Token Cap （before Find） → resumeFromRunId"| end_
  find -->|"pass"| verify
  find -->|"token-cap: Token Cap （before Adversarial Verify） → resumeFromRunId"| end_
  verify -->|"always"| critic2
  critic2 -->|"always"| propose
  propose -->|"always"| divergence
  divergence -->|"pass"| score
  divergence -->|"fail"| synthesize
  score -->|"always"| synthesize
  synthesize -->|"always"| end_
```

blocked / token-cap の復帰先:

| blockedAt | 復帰先 | 備考 |
|---|---|---|
| `Draft Spec` | 人間（オーケストレーターが detail を読んで判断） | fail / blocked / null はすべて中断。taskDescription・maxRounds を見直して再実行 |
| `Token Cap (before Find)` | resumeFromRunId（docs/agents/workflow-resume-runbook.md） |  |
| `Token Cap (before Adversarial Verify)` | resumeFromRunId（docs/agents/workflow-resume-runbook.md） |  |

## aidd-phase2（`aidd-phase2.js`）

パターン: prompt chaining + parallelization + evaluator-optimizer（Review 差し戻し）

予算・上限:
- `DEFAULT_TOKEN_CAP` = 2,500,000
- `MAX_REVIEW_RETRIES` = 3
- `reviewDimensions` = 4

```mermaid
flowchart TD
  spec-check{{"Spec Check: spec-check"}}
  manifest-check{{"Manifest Check: manifest-check"}}
  contract-writer["Contract + DB: contract-writer"]
  db-impl["Contract + DB: db-impl"]
  gate-contract-db{{"Contract + DB: gate-contract-db"}}
  data-impl["Implement: data-impl"]
  api-impl["Implement: api-impl"]
  ui-impl["Implement: ui-impl"]
  gate-implement{{"Implement: gate-implement"}}
  coverage-check{{"Coverage Check: coverage-check"}}
  group-implementer["Coverage Check: group-implementer"]
  gate-coverage{{"Coverage Check: gate-coverage"}}
  integrator["Integrate: integrator"]
  gate-integrate{{"Integrate: gate-integrate"}}
  review["Review: review"]
  classify-review{{"Review: classify-review"}}
  implementer-retry["Review: implementer-retry"]
  end_(["Review: end"])
  spec-check -->|"pass"| manifest-check
  spec-check -->|"blocked: Spec Check → stop-1"| end_
  manifest-check -->|"pass"| contract-writer
  manifest-check -->|"blocked: Manifest Check → stop-1"| end_
  manifest-check -->|"token-cap: Token Cap （before Contract + DB） → resumeFromRunId"| end_
  contract-writer -->|"always"| gate-contract-db
  db-impl -->|"always"| gate-contract-db
  gate-contract-db -->|"pass"| data-impl
  gate-contract-db -->|"minor-only"| data-impl
  gate-contract-db -->|"blocked: Contract + DB → human"| end_
  gate-contract-db -->|"token-cap: Token Cap （before Implement） → resumeFromRunId"| end_
  data-impl -->|"always"| gate-implement
  api-impl -->|"always"| gate-implement
  ui-impl -->|"always"| gate-implement
  gate-implement -->|"pass"| coverage-check
  gate-implement -->|"blocked: Implement → human"| end_
  coverage-check -->|"pass"| integrator
  coverage-check -->|"fail"| group-implementer
  group-implementer -->|"always"| gate-coverage
  gate-coverage -->|"pass"| integrator
  gate-coverage -->|"blocked: Coverage Check → human"| end_
  integrator -->|"always"| gate-integrate
  gate-integrate -->|"pass"| review
  gate-integrate -->|"blocked: Integrate → human"| end_
  gate-integrate -->|"token-cap: Token Cap （before Review） → resumeFromRunId"| end_
  review -->|"always"| classify-review
  classify-review -->|"pass"| end_
  classify-review -->|"retry"| implementer-retry
  implementer-retry -->|"loop"| review
  classify-review -->|"blocked: Review → stop-2"| end_
```

blocked / token-cap の復帰先:

| blockedAt | 復帰先 | 備考 |
|---|---|---|
| `Spec Check` | 停止①（仕様レビュー） | SPEC.md が無い / Part 2 が無い。specPath（絶対パス）を直して再実行 |
| `Manifest Check` | 停止①（仕様レビュー） | approval 未記録 / specHash 不一致。停止①をやり直す |
| `Token Cap (before Contract + DB)` | resumeFromRunId（docs/agents/workflow-resume-runbook.md） |  |
| `Contract + DB` | 人間（オーケストレーターが detail を読んで判断） | detail を読み、SPEC 修正（→停止①）か再実行かを判断 |
| `Token Cap (before Implement)` | resumeFromRunId（docs/agents/workflow-resume-runbook.md） |  |
| `Implement` | 人間（オーケストレーターが detail を読んで判断） |  |
| `Coverage Check` | 人間（オーケストレーターが detail を読んで判断） |  |
| `Integrate` | 人間（オーケストレーターが detail を読んで判断） | 3 回修正しても test/lint/tsc が赤 |
| `Token Cap (before Review)` | resumeFromRunId（docs/agents/workflow-resume-runbook.md） | Review ループの各ラウンド先頭で判定 |
| `Review` | 停止②（構造化レビュー） | レビュー自体ができない観点がある、または 3 回差し戻しても fail が残る |

