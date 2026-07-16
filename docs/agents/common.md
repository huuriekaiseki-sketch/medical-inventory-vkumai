# 共通ルール（全AIエージェント共通）

このファイルは Claude Code・Codex 等、このリポジトリで作業するすべての AI エージェントが
従うべき共通ルールを定義する。ツール固有の設定（サブエージェント・スキル・ワークフロー・
開発フローのオーケストレーション等）は各ツールの入口ファイル（`CLAUDE.md` / `AGENTS.md`）
側を参照すること。

- ドメイン用語（facility・price等が何であるか）は [`domain.md`](./domain.md) を参照
- 各ルールが「なぜ」その設計になったかは [`decisions.md`](./decisions.md) を参照
- 過去に実際に再発した実装ミスのチェックリストは [`known-failure-patterns.md`](./known-failure-patterns.md) を参照（レビュー・Sweep系エージェントは必読）
- 検知手段のないルール（自然言語のみで強制力の無いルール）の一覧は [「検知手段のないルールの棚卸し（issue #339）」](#検知手段のないルールの棚卸しissue-339) を参照

## Next.js バージョンに関する注意

This version has breaking changes — APIs, conventions, and file structure may all differ from
your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing
any code. Heed deprecation notices.

## TRI/RISK 機械判定基準（AIDDパイプライン採用条件）

変更が以下の**いずれか**に触れる場合、Sレーン（軽量レーン）は禁止。必ず M/L 扱いとし、RISK=はい と判定する：

- `supabase/migrations/` 配下のファイル
- `src/lib/supabase/` 配下のファイル
- `middleware.ts`（プロジェクト内のすべての middleware）
- パス・ファイル名・変更内容が以下のドメインに関わるファイル：
  **auth / facility / tenant / organization / inventory / RLS / policy**

この判定は人間の裁量で緩めない（機械判定）。迷ったら高リスク側に倒す。
理由は [`decisions.md`](./decisions.md#なぜtririsk判定を機械判定にし人の裁量で緩めないことにしたか) を参照。

## テスト環境・データ衛生ルール

- **E2E/BSGはテスト専用Supabaseのみに接続する。** 接続情報は `.env.test` に置く（`.env.test.example` 参照）。
  `NODE_ENV=test` のため `.env.local`（本番）は読み込まれず、さらに `e2e/env-guard.ts` が
  許可ホスト以外（＝本番URL・本番service role実行）を**即失敗**させる
- **認証ファイル（`e2e/.auth/user.json`）の漏洩チェックはCI側で行う**（`.github/workflows/e2e.yml`）。
  BSG（ローカルゲート）ではチェックしない方針
- **seed・スクリーンショット・E2E失敗ログ・issue添付に実在施設名・実データを入れない。**
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、`e2e-test-user@example.com`）を使う

## DBスキーマ変更ルール

- **DBスキーマ変更は必ず `supabase/migrations/` 配下のマイグレーションファイル経由で行う。**
  `execute_sql` 等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）
- マイグレーション外で本番/リモートDBに存在するスキーマ変更（トリガー・関数等）を発見した場合は、
  差分をキャッチアップ用マイグレーションとして必ず記録してから作業を進める
- 理由（過去のスキーマドリフト事例）は [`decisions.md`](./decisions.md#なぜdbスキーマ変更をmigrationファイル経由に限定し直接ddl実行を禁止したか) を参照
- **publicスキーマのテーブルを追加/削除するmigrationは、末尾で`SELECT refresh_schema_baseline_snapshot('<そのmigrationのタイムスタンプ>');`を呼ぶ**（issue #305のスキーマドリフト検知が使うbaselineスナップショットを更新するため）。
  呼ばないと、正規のPRレビュー済み変更であっても`table_added`/`table_removed`ドリフトとして恒久的に誤検知され続け、対応するGitHub Issueが自動クローズされなくなる

## ブランチ運用ルール

- **新しいissue・機能の作業を始める前に、現在のブランチが別issue用の未マージPRの対象になっていないか確認する**（`git branch --show-current` → `gh pr list --head <branch>`）。
  なっていた場合は、着手前に `git checkout -b <new-branch> main` で新しいブランチを切ってから進める。
  1つのPRに無関係なissueのコミットが混ざると、レビュアーが混乱し、片方だけ却下・差し戻しになった際に切り分けられなくなる
- **`git checkout -b <new-branch> main` の前に、必ず `git fetch origin main` してから最新の `origin/main` を起点にする**（`git checkout -b <new-branch> origin/main`、または直前に`git merge origin/main`でローカルmainを追従させる）。
  ローカルの`main`ブランチ参照は自動更新されない（`gh pr merge`はリモートを更新するだけで、ローカルの別ブランチにいる間はローカル`main`が古いまま）。古いローカル`main`から新しいブランチを切ると、直近でマージされたPRの変更が丸ごと欠落した状態で作業が進んでしまい、後から気づいて`origin/main`をマージし直す手戻りが発生する

## loop-observabilityログの記録漏れ検知

- AIDDフロー（`aidd-phase2.js` 等）は reviewer/implementer/judge-panel を呼ぶたびに
  `scripts/log-loop-observability.sh` を呼び出す想定だが、これはエージェントへの自然言語指示に
  依存しており強制力がない（Workflow DSL自体がfilesystem API不可のため、ワークフロー本体側から
  機械的にログを書き込むことはできない）。2026-07-07以降、実際に記録が5日分丸ごと欠落していた
  事例がある。理由は [`decisions.md`](./decisions.md) 参照。
- **AIDDフロー（Phase 2以降）を実行する前後で、必ず以下を行うこと。**
  1. 実行前に `wc -l logs/loop-observability.jsonl` で行数を記録する（ファイルが無ければ0）
  2. フロー完了後、戻り値の `stats.expectedLoopObservabilityRecords` を確認する
  3. `scripts/check-loop-observability-gap.sh --before <1の値> --expected <2の値>` を実行する
  4. `hasGap: true`（exit 1）になった場合、記録漏れとして扱い、issue化するか原因を調査する
- これは「記録漏れを機械的に検知する」ものであり、記録そのものを保証する仕組みではない
  （エージェント任せの記録に依存する構造自体の解消は別途検討中）。
- 記録漏れが発生した過去分は、`scripts/lib/reconstruct-loop-observability.ts` で
  `~/.claude/projects/**/subagents/workflows/wf_*/agent-<id>.jsonl` + `.meta.json` から
  timestamp・model・tokens/costUsd・result(status/detail)を再構築できる（issue #312）。
  ただし`feature`は呼び出し時に手動指定が必要、`intent`はプロンプト冒頭1文の抜粋、
  `scenario`は復元不能である旨の固定文言になる（自己申告時点の情報粒度には及ばない）。

## サブエージェント進捗の可視化（issue #18）

- サブエージェント（sweep-db/sweep-ui/sweep-types/sweep-data/implementer/reviewer/integrator/
  judge-panel/proposer/adversarial-verify/completeness-critic/contract-writer）は、
  作業の**開始時**と**終了時**（成功・失敗いずれも）に `scripts/log-agent-progress.sh` を呼び、
  `logs/agent-progress.jsonl` に進捗を記録すること。
  ```
  scripts/log-agent-progress.sh --agent "<自分のagent名>" --feature "<feature名>" \
    --status running --note "<今やっていることの短い説明>"
  # ...作業...
  scripts/log-agent-progress.sh --agent "<自分のagent名>" --feature "<feature名>" \
    --status done --note "<完了内容の短い説明>"    # 失敗時は --status failed
  ```
  `--status` は `starting|running|waiting|done|failed` のいずれか。`feature`名が
  呼び出し元から与えられていない場合は `unknown` を使う。
- 現在の状態は `scripts/show-agent-status.sh` で一覧できる（`--stale-seconds`未満は
  既定180秒＝3分）。`running`/`waiting`のまま既定180秒以上更新がないエージェントは
  「止まってる？」として表示される。
- これも loop-observability と同じ構造的限界を持つ：**エージェントへの自然言語指示に
  依存しており強制力がない**（オーケストレーター側から機械的に書き込ませることはできない）。
  つまり「進捗が表示されない」ことは「本当に止まっている」のか「そもそも記録し忘れている」のか
  区別できない。
- **記録漏れの検知（issue #339、loop-observabilityと同型の仕組み）は実装済み。**
  `aidd-phase1.js` / `aidd-phase2.js` を実行する前後で、必ず以下を行うこと。
  1. 実行前に `jq -s '[.[] | select(.status == "done" or .status == "failed")] | length' logs/agent-progress.jsonl` で件数を記録する（ファイルが無ければ0）
  2. フロー完了後、戻り値の `stats.expectedAgentProgressRecords` を確認する
  3. `scripts/check-agent-progress-gap.sh --before <1の値> --expected <2の値>` を実行する
  4. `hasGap: true`（exit 1）になった場合、記録漏れとして扱い、issue化するか原因を調査する
  - 判定ロジックは `.claude/workflows/lib/agent-progress-gap.js`（loop-observability-gap.jsの
    computeGapを再利用）、期待件数の算出は `.claude/workflows/lib/agent-progress-expectation.js`
    （`aidd-phase2.js` 側はWorkflow DSL制約によりインライン複製）を参照。
  - **これは件数の一致だけを見ており、記録内容の正しさ（本当にそのagentが完了したか、
    fabricationでないか）までは保証しない。** また `aidd-1-1-deep-task.js`（深掘り調査）は
    未対応のまま残っている（Sweep/Completeness Criticの一部のみが進捗記録対象agentTypeで、
    Find/Adversarial Verify/Judge Panel等の大半がそもそも進捗記録の対象外agentTypeで呼ばれて
    いるため、既存の期待値カウント方式をそのまま適用できない）。
- **記録内容の正しさの検証（issue #369の②スコープ）も実装済み。**
  `scripts/verify-agent-progress-transcript.sh` が `logs/agent-progress.jsonl` の自己申告
  （status=done|failed）と、対応するtranscript（`~/.claude/projects/**/subagents/workflows/
  wf_*/agent-<id>.jsonl` + `.meta.json`、`scripts/lib/reconstruct-loop-observability.ts`の
  パース処理を再利用）のstatus/detailを機械比較し、食い違う行のみ検出する。LLM呼び出し不要。
  - agent-progress.jsonlはagentId/workflow実行IDを保持しないため、`--agent`名から既知
    agentType一覧への前方一致でagentTypeを復元し、同じagentType内で最も時刻が近い
    transcriptに貪欲に対応付けるベストエフォート方式（`scripts/lib/
    verify-agent-progress-transcript.ts`の`matchRecords`）。1:1のID突合ではないため、
    高並行実行下では誤対応の可能性が残る。
  - statusの食い違い（自己申告doneなのにtranscriptがfail等）は確定的な指摘として
    `mismatches` に、detailの低一致（文字bigramのJaccard類似度が閾値未満）は
    「要目視確認」の弱いシグナルとして `lowOverlapDetails` に分けて出力する
    （表現が違うだけの正常なケースを誤検知しないため、detail側は自動ブロックしない）。
  - issue #369の①（git diffとの突き合わせ）・③（LLMサンプリング検証）は解禁条件付きで
    保留中。①はagent-progress.jsonlにagentTypeの書き込み系/読み取り専用分類を持たせてから、
    ③は①②が安定稼働した後かつ`verify-claims.sh`と同型のサーキットブレーカー3点セット
    （hooks非継承・セッション非永続化・同時実行数上限）を初回コミットから組み込んだ上でのみ
    着手する。issue本文に理由を明記済み。

## 引き継ぎフォーマット

「できました」で終わる完了報告は禁止。作業完了時（PR本文・セッション終了報告・
`docs/sessions/` への記録のいずれか）は、以下のフォーマットで引き継ぎメモを残す。
確認範囲がAIごとにブレる問題・後任AIがスコープ外を「重大な見落とし」と誤認する問題を防ぐ。

```
## 作業サマリ
- 変更した目的:
- 変更した範囲:
- 触っていない範囲:

## 検証済み
- 実行したコマンド:（`npm run ai:check` の実行有無を含む）
- 確認した画面:
- 確認したDB/RLS:
- 他テナントのIDでアクセスし、弾かれることを確認したか:（RLS/facility境界に触れた場合は必須）

## 既知の未対応
- 今回あえて対応しなかったこと:
- 理由:
- 次に触るなら見る場所:

## 後任AIへの注意
- この実装で壊してはいけない前提:
- 似ているが別物の用語:
- 勝手にリファクタしない場所:
```

- auth/facility/tenant/organization/inventory/RLS/policy に触れた変更は、「検証済み」の
  他テナントIDアクセス確認を省略しない（Issue #24再発防止。チェック観点は
  [`known-failure-patterns.md`](./known-failure-patterns.md) 参照）

## 検知手段のないルールの棚卸し（issue #339）

新しい運用ルールを書く前は必ず[`decisions.md`の該当原則](./decisions.md#なぜ新しい運用ルールに検知手段を先に決める原則を導入したかissue-339)を先に読むこと。
以下は2026-07-14時点で「破られても機械的に気づく手段がない」ルールの一覧（第3層）。
検知手段を実装したら、このルールの説明に検知手段へのリンクを追記してこの表から外すこと。

| ルール | 所在 | 備考 |
|---|---|---|
| `aidd-phase1-router`を入口に使うこと自体（TRI/RISK判定の実施） | 本ファイル「TRI/RISK 機械判定基準」 | 判定ロジック自体は機械的だが、routerを経由せず直接実装に入れば判定がまるごとスキップされる（優先度2候補） |
| 引き継ぎフォーマットの実施 | 本ファイル「引き継ぎフォーマット」 | 既存Stop hook（`doc-suggest-check.sh`等）の拡張候補（優先度3候補） |
| ブランチ運用ルール（着手前PR確認・`origin/main`起点でのbranch作成） | 本ファイル「ブランチ運用ルール」 | 過去に古いローカル`main`起点でbranch作成し手戻りが発生した実績あり |
| サーキットブレーカー（`/goal`設定・テスト修正3回まで・フロー全体上限） | ルートの`CLAUDE.md` | |
| 停止①②以外で止まらず自律進行すること | ルートの`CLAUDE.md`「絶対ルール」 | |
| AIDD stats書き出し（各フェーズでの`write_aidd_stats.sh`呼び出し） | ルートの`CLAUDE.md` | 呼び忘れても気づく手段がない |
| 直接DDL実行禁止（migration経由限定） | 本ファイル「DBスキーマ変更ルール」 | 事後のスキーマドリフト検知（issue #305）はあるが、実行しようとした瞬間に止める事前ブロックはない |
| seed・スクリーンショットに実在施設名を使わない | 本ファイル「テスト環境・データ衛生ルール」 | |
| `aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際のfault injection訓練の実施自体 | 本ファイル「fault injection訓練の実施タイミング（issue #395）」 | 訓練の手順・fixture・setup/teardownスクリプトは用意した（[`fault-injection-drill.md`](./fault-injection-drill.md)）が、「変更時に必ず訓練を実施すること」自体を機械的に強制する手段（例: 該当プロンプト変更を検知してブロックするpre-commit等）は無い。実施記録の記入漏れにも気づく仕組みが無い |

## fault injection訓練の実施タイミング（issue #395）

`.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連のプロンプトを変更したとき、
および四半期に1回の定期訓練として、実際のWorkflow実行を通じてdeny-by-defaultゲート
（Spec Check・Manifest Check）が本当に`blocked`を返すことを実測する。手順・4シナリオの期待値・
実施記録欄は[`fault-injection-drill.md`](./fault-injection-drill.md)を参照。

背景: `aidd-phase2.js`のゲート判定は実際にはエージェントへの自然言語プロンプト指示として実行
されており、`.claude/workflows/lib/`配下の純粋関数ミラーとそのテストはプロンプト文言の変更に
自動追従しない（issue #348で発覚した回避穴と同種のギャップ）。単体テストのgreenだけでは
「実行パスの本体が本当にblockedを返すこと」は証明されないため、実測訓練で埋める。

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| [`docs/agents/common.md`](./common.md) | 全AIエージェント共通ルール（本ファイル）・引き継ぎフォーマット |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
| `scripts/log-agent-progress.sh` / `scripts/show-agent-status.sh` | サブエージェント進捗の記録・一覧表示（issue #18） |
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| [`docs/agents/fault-injection-drill.md`](./fault-injection-drill.md) | `aidd-phase2.js`のdeny-by-defaultゲート実測訓練のランブック（issue #395） |
| `scripts/aidd-fault-injection-setup.sh` / `scripts/aidd-fault-injection-teardown.sh` | fault injection訓練用の`.aidd/run-manifest.json`差し替え・復元（issue #395） |
