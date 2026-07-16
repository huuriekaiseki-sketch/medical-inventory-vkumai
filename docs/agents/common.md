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
  - **このルールのうち「現在のブランチに既にマージ済みのPRが乗っている」ケースは、SessionStart hook（`scripts/check-branch-pr-status.sh`）が機械的に警告する。**
    `git branch --show-current` → `gh pr list --head <branch> --state merged` の結果が空でなければ、セッション開始時に警告メッセージを出す（block不可・warningのみ）。
    実際にissue-20-orders-list-page等、マージ済みブランチ上で気づかず並行作業が続き、重複・陳腐化したworktreeが複数残った実害があったため導入した。
    **「別issueの未マージPRが乗っている」ケース（マージ前の分岐）はこのhookの検知対象外**で、引き続き人手の確認に依存する。
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

## サブエージェント骨格記録の機械強制（issue #423）

上記の`agent-progress.jsonl` / `loop-observability.jsonl`は、いずれもエージェントへの
自然言語指示（「◯◯のタイミングで呼ぶこと」）に依存しており、呼び忘れると記録が丸ごと
欠落する構造的弱点を持つ（2026-07-07以降、実際に5日分欠落した実績がある）。これに対し、
`SubagentStart`/`SubagentStop` hookは「LLMが実行を選ぶことに頼らず決定論的に実行される」
ため、呼び忘れという故障モード自体を構造的に解消できる。

**保証レベル3層（新旧の役割分担）:**

| 層 | 内容 | 記録手段 | 保証レベル |
|---|---|---|---|
| ① 骨格 | agent_id・agent_type・開始/終了・timestamp | `scripts/log-subagent-hook-skeleton.sh`（`SubagentStart`/`SubagentStop` hook） | 機械強制（呼び忘れ得ない） |
| ② feature/attempt | どの機能・何回目の試行か | `scripts/log-agent-progress.sh` / `scripts/log-loop-observability.sh`（自然言語指示） | ベストエフォート（label規約化は未着手、issue #423ステップ3） |
| ③ 自由記述intent/scenario | 何をしようとしていたかの説明 | 同上 | ベストエフォート（欠落許容） |

`logs/subagent-skeleton.jsonl`に、通常のAgent tool経由・Workflowの`agent()`呼び出し経由の
両方のサブエージェント起動が、`{timestamp, hookEvent, sessionId, agentId, agentType,
agentTranscriptPath?, lastAssistantMessage?}`形式で自動記録される。フィールド名はissue #423
ステップ1の実験で実際に観測したhookペイロード（`agent_id`・`agent_type`・
`agent_transcript_path`・`last_assistant_message`等）に基づく。

**既知の限界:**
- ペイロードに`status`（pass/fail/blocked）フィールドは含まれない。`SubagentStop`が発火した
  という事実は「エージェントが完了処理まで到達した」ことの証拠にしかならず、pass/fail/blocked
  の意味判定は引き続き自己申告・transcript突合（`scripts/verify-agent-progress-transcript.sh`）
  に委ねる
- このログは**セッション全体で共通**であり、1つのAIDDフロー実行にスコープされない。並行して
  他の作業（別のAgent tool呼び出し等）が走っていると、そのイベントも同じファイルに混在する。
  特定のフロー実行に絞り込みたい場合は、`agentTranscriptPath`が
  `subagents/workflows/wf_<runId>/`配下かどうかで判別する
- ②feature/attemptを「モデルの善意の報告」から「コードが決定的に埋め込む構造化データ」に
  変えるlabel規約化（issue #423ステップ3、例: `agent()`呼び出しの`label`に
  `implementer:${feature}:attempt${n}`規約を導入する）は未着手のまま残っている
- 既存の`log-agent-progress.sh` / `log-loop-observability.sh` / gap check群は削除しておらず、
  新方式と併存させている（新方式が安定稼働することを確認してから、廃止を別issueで検討する）

## OpenTelemetryと自作JSONLの役割分担（issue #417）

`scripts/log-loop-observability.sh`の自作JSONLは`tokens`/`costUsd`フィールドが常に`null`固定
であり、実測できていなかった。Claude Codeは公式にOpenTelemetryをサポートしており、
トークン数・コスト・ツール実行を自動でエクスポートできる（[monitoring-usage](https://code.claude.com/docs/en/monitoring-usage)）。

**役割分担（両者は併用が正・どちらか一方に統合しない）:**

| 手段 | 記録する内容 | 記録手段 |
|---|---|---|
| OTel | tokens・cost・latency・API呼び出し回数等の定量メトリクス | Claude Code本体が自動エクスポート |
| 自作JSONL（loop-observability / agent-progress / subagent-skeleton） | intent・scenario・pass-fail等のループエンジニアリング固有の意味づけ | 自己申告 or hook（[「サブエージェント骨格記録の機械強制」](#サブエージェント骨格記録の機械強制issue-423)参照） |

**ローカル環境変数（重要: `settings.json`ではなく`settings.local.json`に置くこと）:**

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"
  }
}
```

チーム共有の`.claude/settings.json`には入れない。ローカルcollectorを立てていない他の開発者の
セッションで、毎回OTLPエンドポイントへの接続失敗ノイズが出てしまうため（2026-07-16に判断）。
有効化したい人だけが各自の`settings.local.json`（gitignore対象）に設定する。

**ローカルcollectorの検証手段**: 本番でGrafana等を導入する前段階として、Dockerを使わずに
tokens/costのエクスポートを確認できる最小限のOTLP/HTTP(json)受信サーバを
`scripts/otel-debug-collector.mjs`として用意した（`node scripts/otel-debug-collector.mjs`で
`http://localhost:4318`に待ち受け、受信内容を`logs/otel-debug-collector.jsonl`に記録する）。

**検証済み（2026-07-16）**: 既に起動中のセッション（親プロセス）は`settings.local.json`の
`env`変更を動的に拾わないため、`claude -p ... --no-session-persistence`で**新規プロセス**を
1回起動し、`scripts/otel-debug-collector.mjs`で実際に受信できることを確認した。
`claude_code.token.usage`（input/output/cacheRead/cacheCreationをmodel別に区別）と
`claude_code.cost.usage`（USD、model別）の両metricが実際にエクスポートされていることを
生データで確認済み（例: `claude_code.cost.usage`が`model: claude-sonnet-5`で実数値、
`claude_code.token.usage`が`type: cacheRead`等の内訳付きで実数値として届く）。
**したがって既存の起動中セッションでこの設定を有効化したい場合は、新しいセッションを
開始する必要がある**（設定ファイルを保存しただけでは反映されない）。

送信先はローカル（`http://localhost:4318`）のみ。外部SaaS（Honeycomb/Datadog等）への送信は
医療関連プロジェクトのため必ずユーザー承認を得てから別途検討する。

## AIDDワークフロープロンプトのeval（issue #391）

`.claude/workflows/*.js` 内の自然言語プロンプト（例: db-implの「DBスキーマ変更不要ならblockedではなくpass」という判定基準）は、ユニットテストが効かず、修正の妥当性が「次回実フローでの目視確認」頼みになりがちだった（issue #389のフォローアップ）。fixture SPEC.mdを実際のエージェント（`claude -p --agent <agentType>`、本番と同じモデル）に読ませ、期待するstatus判定になるかを回帰テストする仕組みを用意した。

- `npm run eval:workflows <fixtureセット名>`（例: `npm run eval:workflows db-impl`）で実行する。実体は `scripts/eval-workflow-prompts.sh`。
- fixtureは `scripts/eval-fixtures/<name>/` に `manifest.json`（agentType・プロンプトのビルド元モジュール・モデル・出力スキーマ）と `case-*/spec.md` + `case-*/expected.json` を置く形式。db-implには4ケース（①DB変更あり→pass ②「該当なし」明記→pass ③DB言及なし・ただし文脈から不要と推論可能→pass ④DB変更が必要そうだが対象テーブル・facilityスコープを安全に確定できない真にあいまいなケース→blocked）を用意済み。将来contract-writer等のプロンプトを追加する場合は `scripts/eval-fixtures/<name>/` を増やすだけでよい。
  - **カバレッジの穴の解消（issue #401）**: 当初case-3は「DB言及なし→blocked」を意図していたが、実際にagentへ読ませたところ「クライアント側ソートのみで完結する機能なのでDB変更は不要」と合理的に推論してpass判定した（プロンプトの`blocked`条件は「DBという単語が無い」ではなく「要否を判断できない」ため、この推論はプロンプトの文言上は正当）。case-3はそのまま`case-3-no-db-mention-inferable`としてpass期待に据え置き、別途「DB変更は必要そうだが対象テーブル・facilityスコープを安全に確定できない」という真にblockedを要するケースを`case-4-genuinely-ambiguous`として追加した。あわせてdb-implプロンプト（`db-impl.js`/`aidd-phase2.js`）に「DB変更が必要そうだが対象テーブル・カラム設計・facilityスコープを安全に確定できない場合もblocked（fail扱いにしない）」という基準を明記し、fail/blockedの線引きを明確化した。
  - **残存する非決定性**: 上記修正後も、case-4は複数回の実測で`blocked`判定が大半だが稀に別のstatusになることがある（自然言語プロンプトによる判断である以上、完全な決定性は保証できない）。完全な決定性が必要になった場合は、より強い制約（例: 「曖昧な場合は必ず一度人間に確認する」）の追加を別issueで検討すること。
- 各fixtureはローカルの一時ディレクトリへリポジトリを `git clone --depth 1` してから実行する。本体の `supabase/migrations/` 等を実際に汚さないための隔離（fixture①はマイグレーションファイルを実際に書こうとするため）。
  - **Write/Bash権限のスタック問題の解消（issue #401）**: `claude -p`をheadlessで呼び出すと承認者が接続されておらず、Write/Bashの権限確認が永久に解決されずに`fail`報告になる事例を観測していた（当初は「セッション固有の現象かもしれない」として未検証のまま残していたが、原因を切り分けて確定した）。`run_agent()`に`--permission-mode bypassPermissions`を追加して解消済み。呼び出し先は必ず使い捨てのgit clone上であり、実リポジトリは汚さないため全権限自動承認を許容している。
  - status不一致の原因調査には `EVAL_WORKFLOW_PROMPTS_DEBUG_DIR` を指定すると各caseの生出力を保存できる。
  - fixtureセットが大きい/曖昧なケースを含む場合、既存のデフォルトタイムアウト（420秒）でも実測でタイムアウトすることがある。`EVAL_WORKFLOW_PROMPTS_TIMEOUT_SECONDS`で調整可能。
- `claude -p` 呼び出しには `--setting-sources ""` と `--no-session-persistence` を初回コミットから組み込んでいる（verify-claims.shが2026-07-14に経験したStop hook再帰暴走と同型の事故を未然に防ぐため）。同時実行数の上限によるサーキットブレーカーも同様に組み込み済み。
- `--setting-sources ""` は `.claude/agents/*.md` のファイル探索によるカスタムagent型解決も同時に無効化してしまうため（`--agent implementer` が `not found` になる）、実際の `claude -p` 呼び出しでは `.claude/agents/<agentType>.md` のYAML frontmatterを除いた本文を `--agents` フラグで明示的に注入している（`scripts/lib/build-eval-agent-json.mjs`）。`--setting-sources ""` を弱めずにこの問題を回避するための組み合わせであり、削るとevalの実エージェント呼び出しが全滅する load-bearing な仕組みなので、harnessを触る際は要注意。
- モデルは意図的に安価なモデルへ差し替えていない（実際のdb-impl実行時と同じsonnet）。安いモデルでevalすると「本番で実際に動くもの」と異なる挙動をテストすることになり、モックが実環境の挙動を隠す典型的な落とし穴に陥るため。
- プロンプト本文のドリフト対策として、db-implプロンプトの正本を `.claude/workflows/lib/prompts/db-impl.js` に切り出し、`aidd-phase2.js` 側のインライン複製との一字一句の一致を `.claude/workflows/lib/__tests__/workflow-prompt-sync.test.js` が機械的に検証する（`npm test`に含まれる）。
- **運用ルール（検知手段なし）**: `.claude/workflows/*.js` のプロンプト文言を変更したPRは、マージ前に `npm run eval:workflows <対応するfixtureセット>` を手動実行することが望ましい。CI化（PR時の自動実行）は実エージェント呼び出しの課金コストを理由に見送った。**この運用ルール自体、実行し忘れても気づく機械的な手段が無い**（下記「検知手段のないルールの棚卸し」参照）。将来案として、`.claude/workflows/*.js` が変更されたPRに対し、evalが最近実行された形跡（タイムスタンプファイル等）の有無だけを軽量にチェックするgit hookを検討したが、今回は見送った。

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
特に、新しい検知・検証メカニズム自体を追加する際は「その起動トリガーは機械（hook/CI/cron/npm test）
か人か」を先に確認すること（issue #411）。人起動なら第3層ルールの削減ではなく追加になるだけで、
下記棚卸し表に行が1つ増えて終わる。
以下は2026-07-14時点で「破られても機械的に気づく手段がない」ルールの一覧（第3層）。
検知手段を実装したら、このルールの説明に検知手段へのリンクを追記してこの表から外すこと。

| ルール | 所在 | 備考 |
|---|---|---|
| `aidd-phase1-router`を入口に使うこと自体（TRI/RISK判定の実施） | 本ファイル「TRI/RISK 機械判定基準」 | 判定ロジック自体は機械的だが、routerを経由せず直接実装に入れば判定がまるごとスキップされる（優先度2候補） |
| 引き継ぎフォーマットの実施 | 本ファイル「引き継ぎフォーマット」 | 既存Stop hook（`ai-check-suggest.sh`等）の拡張候補（優先度3候補） |
| ブランチ運用ルール（`origin/main`起点でのbranch作成） | 本ファイル「ブランチ運用ルール」 | 過去に古いローカル`main`起点でbranch作成し手戻りが発生した実績あり。着手前PR確認のうち「マージ済みPRが乗っている」ケースのみ`scripts/check-branch-pr-status.sh`（SessionStart hook）で検知済み。「別issueの未マージPRが乗っている」ケースと`origin/main`起点確認自体は未検知のまま |
| サーキットブレーカー（`/goal`設定・テスト修正3回まで・フロー全体上限） | ルートの`CLAUDE.md` | |
| 停止①②以外で止まらず自律進行すること | ルートの`CLAUDE.md`「絶対ルール」 | |
| AIDD stats書き出し（各フェーズでの`write_aidd_stats.sh`呼び出し） | ルートの`CLAUDE.md` | 呼び忘れても気づく手段がない |
| 直接DDL実行禁止（migration経由限定） | 本ファイル「DBスキーマ変更ルール」 | 事後のスキーマドリフト検知（issue #305）はあるが、実行しようとした瞬間に止める事前ブロックはない |
| seed・スクリーンショットに実在施設名を使わない | 本ファイル「テスト環境・データ衛生ルール」 | |
| `aidd-phase2.js`のSpec Check/Manifest Check関連プロンプトを変更した際のfault injection訓練の実施自体 | 本ファイル「fault injection訓練の実施タイミング（issue #395）」 | 訓練の手順・fixture・setup/teardownスクリプトは用意した（[`fault-injection-drill.md`](./fault-injection-drill.md)）が、「変更時に必ず訓練を実施すること」自体を機械的に強制する手段（例: 該当プロンプト変更を検知してブロックするpre-commit等）は無い。実施記録の記入漏れにも気づく仕組みが無い |
| `.claude/workflows/*.js` 変更時の`npm run eval:workflows`手動実行 | 本ファイル「AIDDワークフロープロンプトのeval」 | CI化は実エージェント呼び出しの課金コストで見送り。実行し忘れに気づく手段は無い（issue #391） |

## fault injection訓練の実施タイミング（issue #395）

`.claude/workflows/aidd-phase2.js`のSpec Check/Manifest Check関連のプロンプトを変更したとき、
および四半期に1回の定期訓練として、実際のWorkflow実行を通じてdeny-by-defaultゲート
（Spec Check・Manifest Check）が本当に`blocked`を返すことを実測する。手順・4シナリオの期待値・
実施記録欄は[`fault-injection-drill.md`](./fault-injection-drill.md)を参照。

背景: `aidd-phase2.js`のゲート判定は実際にはエージェントへの自然言語プロンプト指示として実行
されており、`.claude/workflows/lib/`配下の純粋関数ミラーとそのテストはプロンプト文言の変更に
自動追従しない（issue #348で発覚した回避穴と同種のギャップ）。単体テストのgreenだけでは
「実行パスの本体が本当にblockedを返すこと」は証明されないため、実測訓練で埋める。

## ツール制約回避のload-bearing workaround棚卸し（issue #413）

2026-07-16のmentor設計レビューで、AIDDフレームワークの相当部分がツール（Workflow DSL /
`claude -p`）の制約・不具合への回避策でできていることが確認された。各回避策はdecisions.md等に
「なぜ」が記録されガードも付いているが、**Claude Code側の更新で回避策の前提が壊れると、検知網
自体が静かに全滅しうる**（回避策 = 検知網の土台、というメタ構造のため）。ツール本体を更新した
とき、またはeval/ワークフロー実行が理由不明に失敗し始めたときは、まずこの表を確認すること。

| 回避策 | 場所 | 前提とするツール挙動 | 解除条件／破損条件 | smoke test |
|---|---|---|---|---|
| args `typeof === 'string'` → `JSON.parse`防御 | `.claude/workflows/aidd-phase1-router.js`（正本: `.claude/workflows/lib/resolve-workflow-args.js`） | Workflowツールがargsをobjectで渡してもstringで届く不具合（[`decisions.md`](./decisions.md#なぜaidd-phase1-routerjsでargsをjsonparseする防御コードを入れたか)） | **解除**: ツール側がargsを常にobjectで渡すよう修正されれば、この分岐に到達しなくなるだけで副作用なし（前方互換設計のため削除は任意）。**破損**: このガード自体が壊れることは想定しにくい（`typeof`判定のみのため） | `resolve-workflow-args.test.js`（npm test内） |
| `--setting-sources ""` + `--agents`フラグでのagent定義注入 | `scripts/lib/build-eval-agent-json.mjs` | `--setting-sources ""`が`.claude/agents/*.md`探索も無効化する挙動 | **解除**: `--setting-sources`が`.claude/agents/`探索のみを無効化しないよう修正されれば不要。**破損**: `--agents`フラグのJSON構造・優先順位が変更されると`--agent implementer`解決自体が失敗し、evalの実エージェント呼び出しが全滅する（common.md「AIDDワークフロープロンプトのeval」に既述のload-bearing箇所） | JSON出力形式は`build-eval-agent-json.test.mjs`（npm test内）で検証済み。**ただし実際に`claude -p --agents ... --agent <type>`でagent解決できるかどうかの専用smoke testは無い**（`claude -p`の実呼び出しが必要でCI化見送り済みのため、issue #391と同じ判断。`npm run eval:workflows db-impl`を手動実行した際に暗黙的に再検証されるのみ） |
| プロンプト正本の切り出し＋インライン複製＋sync test | `.claude/workflows/lib/prompts/db-impl.js` ⇔ `aidd-phase2.js`、`.claude/workflows/lib/spec-check.js` / `manifest-check.js` ⇔ `aidd-phase2.js` | Workflow DSLがfilesystem API不可でローカルモジュールをrequire/importできない制約 | **解除**: Workflow DSLがローカルモジュールをimportできるようになれば、インライン複製自体が不要になり正本を直接importする形に変えられる。**破損**: プロンプト文言変更時にインライン複製側を追従させ忘れると乖離する（これを検知するのがsync testの目的そのもの） | `workflow-prompt-sync.test.js`（npm test内） |
| eval fixture manifestとaidd-phase2.js内スキーマ定義の同期 | `scripts/eval-fixtures/db-impl/manifest.json` ⇔ `aidd-phase2.js`内のスキーマ定義 | 同上（Workflow DSL importの制約） | **解除**: 同上。**破損**: スキーマ定義がドリフトすると、evalが実際のプロンプトと異なるスキーマでテストしてしまい気づかれない | `eval-fixture-manifest-schema-sync.test.js`（npm test内） |
| 進捗・観測ログの自然言語指示依存 | `scripts/log-agent-progress.sh` / `scripts/log-loop-observability.sh`呼び出し | Workflow DSLがfilesystem API不可で、ワークフロー本体から機械的にログを書き込めない制約 | **解除**: 同上（importまたは直接fs書き込みが可能になれば、本体側から機械的に記録できる設計に変更可能）。**破損**: 元々「壊れる」ものではなく「そもそも書かれない」リスクが常態（自然言語指示依存のため） | 記録漏れの事後検知（`check-loop-observability-gap.sh` / `check-agent-progress-gap.sh`）はあるが、その実行自体が人起動であり第3層ルールとして上表に残っている（issue #411） |

**Claude Code更新時の確認手順**: (1) 上表の「smoke test」列にnpm test内のテストがある項目は
`npm test`を実行して確認する。(2) smoke testが「無い」と明記されている項目（現状は
`--setting-sources`+`--agents`の組み合わせのみ）は`npm run eval:workflows db-impl`を一度手動実行し、
4ケース中`case-1`〜`case-4`がエージェント呼び出し自体（`NG: エージェント実行が失敗しました`
以外の結果）に到達しているかを確認する。(3) 新しいload-bearing workaroundを追加した場合は、
この表に行を追加すること（issue #411の原則どおり、smoke testを機械トリガーに載せられないなら
その旨をこの表に明記し、prose追加だけで済ませない）。

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
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
