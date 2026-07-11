# SPEC: AIDDフェーズの返却値をpass/fail/blockedに統一する型を定義する

対応issue: #41

## 背景（Phase 1調査結果）

現状、`.claude/workflows/` 配下のAIDDワークフロースクリプトは、`agent()`呼び出しの成否を機械的に判定していない。

- `aidd-phase1.js`（sweep-db/data/ui/types L28-33）: `agent()`の返却値をそのまま`?? '指摘なし'`で受け取るだけ。`findingCount`は`r !== '指摘なし'`という**固定文字列一致**で判定している（L48-49）
- `aidd-phase2.js`（contract-writer/db-impl L36-43, data-impl/api-impl/ui-impl L54-67, integrator L74-77, reviewer L91-96）: `implSuccessCount`は`filter(Boolean).length`という**truthy判定のみ**（L116）。エージェントが失敗を報告する文章を返しても、文字列が空でなければ成功としてカウントされてしまう
- `aidd-1-1-deep-task.js`: `isNew()`(L49)や`criticResult.includes('追加調査対象:')`(L70)など、**キーワード文字列一致による分岐**が2箇所あり、いずれもSweepループの継続/終了という制御フローに直結している
- `aidd-phase1-router.js`: `workflow()`の結果をそのまま返すだけで、自身は成否判定をしていない（下流workflowの結果を素通しするため、本issueの型導入により自動的に恩恵を受ける想定。本issueの直接対象外）
- `aidd-session-report.js`: `phase1Stats`/`phase2Stats`から`agents`/`rounds`/`findingCount`/`implSuccessCount`等の**件数集計のみ**を読んでおり、個々のagentが「なぜ失敗したか」「ブロックされたか」を区別できない

## やること（Part 1: 型定義）

### 1-1. 共通型

`docs/agents/agent-result-schema.md`に以下を新設する。

```
AgentResult = {
  status: 'pass' | 'fail' | 'blocked',
  detail: string        // 人間可読の要約(現状の自由記述文字列をそのまま格納)
}
```

### 1-2. status追加対象と判定基準（agent呼び出しごとに1行）

**`aidd-phase1.js`**

| 呼び出し (L28-33) | pass | fail | blocked |
|---|---|---|---|
| sweep-ui / sweep-data / sweep-db / sweep-types（4本） | 調査を最後まで実行できた（指摘の有無は問わない。指摘内容はstatusではなくdetailで表現） | 該当なし（調査系エージェントに「失敗」概念は無く、常にpass/blockedいずれかを返す） | 権限不足・対象コード不在等で調査そのものが実行できなかった |

**`aidd-phase2.js`**

| 呼び出し | pass | fail | blocked |
|---|---|---|---|
| contract-writer (L36-39) | 型定義・APIインターフェース型を確定できた | 型定義を試みたが不完全・矛盾がある | SPEC.mdが存在しない/読めない |
| db-impl (L40-43) | マイグレーション実装が完了した | マイグレーションを試みたがエラー・矛盾がある | SPEC.mdが存在しない、またはPart2にマイグレーション情報が無く着手不能 |
| data-impl (L55-58) / api-impl (L59-62) / ui-impl (L63-66) | 担当範囲の実装を完了できた | 実装したが明らかに不完全、またはcontract-writer/db-implの結果と矛盾する | SPEC.mdが見つからない、またはcontract-writer/db-implの完了報告が空で着手できなかった |
| integrator (L74-77) | npm test・npm run lintが最終的に緑で統合完了 | 3回の修正試行後もtest/lintが赤のまま | SPEC.mdが見つからない、またはいずれかのimplエージェントの完了報告に「仕様書が見つからない」「作業を開始できない」旨の記述がある（現行プロンプトL75の異常検知指示に対応） |
| review:correctness / coverage / redundancy / type-safety（4本, L91-96） | レビューを完了し指摘なし | レビューを完了し1件以上の指摘がある（重大度による絞り込みは#42のスコープとし、ここではpass/failの二値のみ） | レビュー対象のコード・SPEC.mdが見つからずレビュー自体ができなかった |

**`aidd-1-1-deep-task.js`**：Part 1-3で表として詳細化する。

## やること（Part 1-3: `aidd-1-1-deep-task.js`のstatus対象／対象外 一覧）

このファイルはagent呼び出しが9系統ある。呼び出し元（本ファイル自身）が使う判定方法ごとに、status追加の要否を以下の表で確定する。

| # | 呼び出し（行番号） | 現状の判定方法 | status追加 | 理由 |
|---|---|---|---|---|
| 1 | sweep-ui/data/db/types（L43-46, 4本） | `isNew()`＝`r.trim() !== '指摘なし'` という文字列一致で**ループ継続判定**に使用 | **対象** | 制御フロー（Loop Until Dry の継続要否）が文字列一致に依存しており、本issueが解消すべき典型例。基準: pass=調査完了(指摘有無問わず)/blocked=調査不能/fail=該当なし |
| 2 | completeness-critic 1周目（L65-68） | `criticResult.includes('追加調査対象:')` という文字列一致で**ループ継続判定**に使用 | **対象** | 同上。基準: pass=批評を完了した(追加調査の要否は問わない)/blocked=Sweep結果が空で批評に着手できなかった/fail=該当なし |
| 3 | draft-spec（L94-97） | 判定なし。生成結果をそのまま次フェーズに渡すのみ | **対象** | 現状schemaなしの自由記述で、生成失敗（空・調査結果を反映できない内容）を呼び出し元が検知できない。基準: pass=仕様書ドラフトを生成できた/fail=生成されたが調査結果を反映していない等明らかに不完全/blocked=Sweep結果が空でドラフト生成に着手できなかった |
| 4 | find（L133-136, lens×5） | 既存の`FINDING_SCHEMA`（severity等）で完結。呼び出し元はfindings配列のseverityを直接参照 | **対象外** | 汎用statusを読む消費先が本ファイル内に存在しない（ドメインschemaで完結済み） |
| 5 | verify（Adversarial Verify, L162-166） | 既存の`VERDICT_SCHEMA`（refuted/reason）で完結 | **対象外** | 同上 |
| 6 | completeness-critic 2周目（L193-196） | 既存の`CRITIC_SCHEMA`（gaps）で完結。1周目(#2)と異なり制御フロー分岐には使われない | **対象外** | 同上 |
| 7 | propose（Judge Panel, L235-239, stance×3） | 既存の`PROPOSAL_SCHEMA`で完結 | **対象外** | 同上 |
| 8 | score（Judge Panel, L246-249, lens×3×proposal数） | 既存の`SCORE_SCHEMA`で完結。avgScore集計に使用 | **対象外** | 同上 |
| 9 | synthesize（L266-269） | 判定なし。最終成果物として`return`されるのみ | **対象** | 自由記述かつワークフローの最終出力。生成失敗（必須セクション欠落等）を呼び出し元が検知できない。基準: pass=統合提案を生成できた/fail=生成されたが必須修正等のセクションが欠落するなど明らかに不完全/blocked=survived/gaps/winnerのいずれかが揃わず統合に着手できなかった |

**まとめ**: 9系統中、status追加対象は **#1・#2・#3・#9（4系統）**。#4-8（find/verify/critic-2周目/propose/score）はドメイン固有schemaで完結しており対象外。

## やること（Part 2: 集計ロジックの置き換え）

1. `aidd-phase1.js`の`findingCount`（L48-49）は、**statusとは別軸**として維持する。sweep系は「fail」を返さない設計（Part 1-2参照）のため、`status`だけでは「指摘が見つかった本数」を表現できない。よって以下の2つを両方stats（L44-50）に持たせる
   - `findingCount`（従来通り、意味は変えない）: `[uiResult, dataResult, dbResult, typesResult].filter(r => r.status === 'pass' && r.detail !== '指摘なし').length`（＝完遂できた調査のうち、実際に指摘が見つかった本数。`status === 'pass'`の条件を加えるのは、blocked時の`detail`（エラーメッセージ等）がたまたま`'指摘なし'`と一致しない場合に誤って「指摘あり」として数えてしまう既存の潜在バグを防ぐため）
   - `blockedCount`（新規追加）: `[uiResult, dataResult, dbResult, typesResult].filter(r => r.status === 'blocked').length`（Part 2-4でaidd-session-report.jsに表示するblocked件数の集計元）
2. `aidd-phase2.js`の`implSuccessCount`（L116）を、`filter(Boolean).length`から`filter(r => r.status === 'pass').length`に置き換える
3. `aidd-1-1-deep-task.js`の`isNew()`（L49）・`hasNewCriticFindings`（L70）を、上記表#1・#2のstatusベース判定に置き換える（ループ継続条件: 新規findingsまたはcriticのstatusがpass以外だった場合、等に再設計）
4. `aidd-session-report.js`のテンプレートに、pass/fail/blocked件数の内訳表示を追加する（既存の「実装成功: X/Yグループ」表示に加えて、blocked件数を明示）

## スコープ外（別issue）

- `aidd-phase2.js`にstatusベースの品質ゲート（fail時に後続フェーズをブロックする）を実装するのは **issue #42** の範囲。本issueでは型定義とAgentResultの集計置き換えまでとし、ゲート制御ロジック自体は追加しない
- reviewerの指摘に重大度(critical/important/minor)を持たせてfail判定を絞り込むのも**issue #42**の範囲とする

## 完了条件

- 上表で「対象」とした呼び出し（`aidd-phase1.js`全4本、`aidd-phase2.js`全10本、`aidd-1-1-deep-task.js`の4系統）が`status`フィールドを持つ構造化オブジェクトを返すようになっている
- `findingCount`（status+detailの組み合わせ）・`implSuccessCount`（status参照）・Loop Until Dryの継続判定が、文字列一致・truthy判定から置き換わっている
- 既存のnpm testが引き続きグリーンである
- `docs/agents/agent-result-schema.md`に型定義と、各agent呼び出しの判定基準（本SPECの表の内容）が記載されている
