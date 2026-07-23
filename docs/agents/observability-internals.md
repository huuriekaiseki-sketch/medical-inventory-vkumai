# 観測・Evalインフラの内部詳細

このファイルは [`common.md`](./common.md) の「毎セッション必須ルール」から分離した参照ドキュメントである（issue #486）。行動を変える指示ではなく、common.mdの各手順（loop-observability記録・agent-progress記録・eval実行ルール等）が「なぜその形になっているか」「内部でどう動いているか」「既知の限界は何か」を知りたいときに読む。common.md側には各節への1行リンクが残っている。

## loop-observability記録漏れ検知の背景と既知の限界

AIDDフロー（`aidd-phase2.js` 等）は reviewer/implementer/judge-panel を呼ぶたびに
`scripts/log-loop-observability.sh` を呼び出す想定だが、これはエージェントへの自然言語指示に
依存しており強制力がない（Workflow DSL自体がfilesystem API不可のため、ワークフロー本体側から
機械的にログを書き込むことはできない）。2026-07-07以降、実際に記録が5日分丸ごと欠落していた
事例がある。理由は [`decisions.md`](./decisions.md) 参照。

- **既知の限界**: gap check state（`record-gap-check-state.sh`）への記録自体は依然オーケストレーターの
  自己申告（Workflow DSLがfilesystem API不可のため）。「書いたのにcheckし忘れる」はStop hookで
  構造的に消えたが、「そもそも書き忘れる」は残る
- これは「記録漏れを機械的に検知する」ものであり、記録そのものを保証する仕組みではない
  （エージェント任せの記録に依存する構造自体の解消は別途検討中）。
- 記録漏れが発生した過去分は、`scripts/lib/reconstruct-loop-observability.ts` で
  `~/.claude/projects/**/subagents/workflows/wf_*/agent-<id>.jsonl` + `.meta.json` から
  timestamp・model・tokens/costUsd・result(status/detail)を再構築できる（issue #312）。
  ただし`feature`は呼び出し時に手動指定が必要、`intent`はプロンプト冒頭1文の抜粋、
  `scenario`は復元不能である旨の固定文言になる（自己申告時点の情報粒度には及ばない）。

## agent-progress記録の構造的限界・記録内容検証の詳細

サブエージェント（sweep-db/sweep-ui/sweep-types/sweep-data/implementer/reviewer/integrator/
judge-panel/proposer/adversarial-verify/completeness-critic/contract-writer）の進捗記録
（`scripts/log-agent-progress.sh`、common.md「サブエージェント進捗の可視化」参照）も
loop-observabilityと同じ構造的限界を持つ：**エージェントへの自然言語指示に依存しており
強制力がない**（オーケストレーター側から機械的に書き込ませることはできない）。つまり
「進捗が表示されない」ことは「本当に止まっている」のか「そもそも記録し忘れている」のか
区別できない。

- **記録漏れの検知（issue #339、loop-observabilityと同型の仕組み）は実装済み。** 判定ロジックは
  `.claude/workflows/lib/agent-progress-gap.js`（loop-observability-gap.jsのcomputeGapを再利用）、
  期待件数の算出は `.claude/workflows/lib/agent-progress-expectation.js`
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

**第4の記録層（issue #442調査 → issue #462・#493で組み込み済み）**: Workflowツールが
`agent()`呼び出しごとに書き出す`journal.jsonl`（`subagents/workflows/wf_<runId>/journal.jsonl`）
を実機観測したところ、各行の`agentId`フィールドが同じディレクトリの`agent-<agentId>.jsonl`
（フルtranscript）・`agent-<agentId>.meta.json`（メタデータ）のファイル名と完全一致することを
確認した（`{"type":"result","key":"v2:<promptとoptsのハッシュ>","agentId":"...","result":{...}}`
という形式）。これにより、transcriptの最終メッセージをパースして復元している`result`
（status/detail等）を、journal.jsonlの`result`フィールドからパース不要で直接取得できる。
ただし`key`はハッシュ値のみでprompt本文を含まないため、agentType/feature/labelの復元には
引き続きtranscript/meta.json側の情報が必要（この制約は変わらない）。また journal.jsonlは
**Workflowツール経由の`agent()`呼び出しでのみ生成される**（通常のAgent tool直接起動には
存在しない）。

- **reconstruct側の組み込み（issue #462、PR #467でマージ済み）**: `reconstruct-loop-observability.ts`の
  `reconstructWorkflowDir`が`loadJournalResults`（`export`済み）でjournal.jsonlの構造化result
  （statusが`pass|fail|blocked`のもの）を優先し、無ければ従来のtranscriptパース結果へ
  フォールバックする
- **verify側の組み込み（issue #493で実装済み）**: `verify-agent-progress-transcript.ts`の
  `loadTranscripts`も同じ`loadJournalResults`を再利用し、`TranscriptRecord`の`status`/`detail`
  をjournal.jsonl優先で取得する（`endTimestamp`はjournal.jsonlにタイムスタンプが無いため
  引き続きtranscript側から取得し、`matchRecords`の時刻近接突合ロジックには影響しない）

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

**常時記録化と起動忘れ検知（issue #430）**: `otel-debug-collector.mjs`はデバッグ用の手動起動
collectorであり、常時稼働ではない。issue #419（effortフィールド追加の効果測定）でbefore/after
比較ができなかった真因は「変更前に計測を忘れた」という運用ミスではなく、「tokens/costが
どこにも常時記録されていない」という構造の問題だった。これに対応するため以下を実装した:

- `otel-debug-collector.mjs`は`logs/otel/YYYY-MM-DD.jsonl`に日付ローテーションして記録する
  （既定30日で古いログを自動削除。`OTEL_DEBUG_COLLECTOR_RETENTION_DAYS`で変更可）。単一ファイル
  への無限追記による肥大化を避け、日付単位で過去のbaselineを事後クエリできるようにした
- SessionStart hook（`scripts/check-otel-collector-status.sh`）が、`CLAUDE_CODE_ENABLE_TELEMETRY=1`
  が設定されているにもかかわらずcollectorに接続できない場合に警告する。issue #411原則
  （「起動トリガーは機械か人か」）に照らし、常時起動そのもの（launchd常駐化等）までは行わず、
  「起動し忘れても気づける」という最小限のバーに留めた。OTelを有効化していない（既定）環境では
  何もしない
- **実測（2026-07-16）**: OTelの各metric（`claude_code.session.count`/`cost.usage`/
  `token.usage`/`active_time.total`）のdata point属性に`session.id`（Claude Codeのhook入力
  JSONと同じUUID形式）が含まれることを実際のheadlessセッションで確認した。これにより、
  自作JSONL（loop-observability.jsonl等、hook入力の`session_id`を記録している）とOTel側の
  データを`session.id`で突合できる。ただし`agentType`（reviewer/implementer等の粒度）に
  相当する属性は無く、`query_source`（例: `"main"`）等の粗い区別に留まる。サブエージェント
  単位での突合には、タイムスタンプの近接性等の追加のヒューリスティックが必要（未実装）。

## statuslineでcontext・コスト・レート制限を可視化（issue #446）

サーキットブレーカー運用（ルートの`CLAUDE.md`参照）は`/goal`のターン数上限設定に依存するが
（issue #441の実機確認で、`/goal`は時間ベースの上限を直接サポートしないと判明したため、
本節の記述も「ターン/時間上限」から「ターン数上限」に訂正した）、
context使用率・セッションコスト・5h/7dレート制限の消費状況を気づく手段が手動確認
（`/context`等の実行）のみで、常時可視化する仕組みが無かった。公式のstatusline機能
（stdin JSONをシェルスクリプトに渡し、出力をターミナル下部に表示する仕組み。
[公式ドキュメント](https://code.claude.com/docs/en/statusline)でスキーマを確認済み）を使い、
`scripts/statusline.sh`として実装した。

- 表示内容: モデル名・現在のgitブランチ・context使用率（`context_window.used_percentage`）・
  セッションコスト（`cost.total_cost_usd`）・5時間/週次レート制限使用率
  （`rate_limits.five_hour/seven_day.used_percentage`）
- `rate_limits`はClaude.ai Pro/Max契約かつセッション最初のAPI応答後にのみ存在し、
  `context_window.used_percentage`もセッション序盤は`null`になりうる（公式ドキュメント記載の
  既知の欠落パターン）ため、いずれも`jq`の`// empty`で欠落・nullを許容し、値が無い項目は
  行から消える設計にした
- **個人opt-in方式**: [OpenTelemetryの節](#opentelemetryと自作jsonlの役割分担issue-417)と同じ
  理由（表示スタイルの好み・ターミナルのUnicode/絵文字対応状況は開発者ごとに異なるため）で、
  チーム共有の`.claude/settings.json`には登録しない。有効化したい人だけ各自の
  `settings.local.json`（gitignore対象）に以下を追加する:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "<リポジトリ絶対パス>/scripts/statusline.sh"
    }
  }
  ```
- テストは`scripts/statusline.test.sh`（`bash scripts/statusline.test.sh`で実行、`npm test`には
  含まれない。statusline.shはClaude Code本体からstdin経由で呼ばれる性質上vitest対象外という、
  `show-agent-status.sh`等と同じ理由）。公式ドキュメント掲載のサンプルJSON・欠落パターンを
  fixtureとして固定した
- **`subagentStatusLine`実装（issue #446の設計案2、2026-07-18実機観測により着手）**: 見送りの
  理由だった「フィールド値の完全なJSONサンプルが無い・`startTime`の型が未確認」を、実際の
  ターミナルCLI（通常のインタラクティブ`claude`セッション、Claude Agent SDK経由のセッションでは
  `subagentStatusLine`自体が発火しないため不可）で解消してから実装した。
  - **実機観測の手順**: `scripts/subagent-statusline-debug-collector.sh`を一時的に
    `subagentStatusLine`として`settings.local.json`に配線し、受け取った生JSONを
    `logs/subagent-statusline-debug.jsonl`（gitignore対象）にそのまま追記するだけの捕捉専用
    スクリプトを用意した。人間が実際のターミナルでExploreエージェントを複数並列実行する
    タスクを依頼し、パネル表示中に捕捉した
  - **実機観測で確定した事実**:
    - `startTime`はUnix epochミリ秒（13桁、実測値`1784374971089`は2026-07-18と整合）
    - `tasks[]`の各要素に`name`が無いケースがある（Task tool経由の`local_agent`型は
      `label`/`description`のみで`name`は付与されない）
    - タスク完了時は`status`が`"done"`等に変わるのではなく、**`tasks`配列から丸ごと消える**
      （実測ではrunning以外のstatus値は一度も観測できなかった）
    - `contextWindowSize`はモデル未解決時は省略される（公式ドキュメント記載どおり実測でも確認）
  - 上記を踏まえ`scripts/subagent-statusline.sh`を実装した。表示内容は
    `<状態アイコン> <label優先のフォールバック名> <tokenCountをk単位に整形> <context使用率%>`を
    `columns`幅に切り詰めて`{"id":..., "content":...}`形式で1行ずつ出力する
  - **既知の未確認事項**: `status`が`"running"`以外の値を取るケース（`waiting`/`failed`等）は
    実機で一度も観測できておらず、アイコン分岐は公式ドキュメントの一般的な語彙からの類推に
    とどまる。`startTime`から経過時間を表示する機能は型が確定した後でも今回は実装していない
    （tokenベースの表示のみで着手条件を満たしたため。追加する場合は別issueで検討すること）
  - 個人opt-in方式・テスト方針は上記statusline.shと同じ。設定は
    ```json
    {
      "subagentStatusLine": {
        "type": "command",
        "command": "<リポジトリ絶対パス>/scripts/subagent-statusline.sh"
      }
    }
    ```
    テストは`scripts/subagent-statusline.test.sh`（`bash scripts/subagent-statusline.test.sh`で
    実行、`npm test`には含まれない。fixtureは実機捕捉した実際のJSON構造を元にしている）

## agents設定変更時のbaselineスナップショット機械強制（issue #429）

issue #419の完了条件「loop-observabilityでbefore/afterのコスト・精度を比較」は、着手時点で
beforeデータの取得手段が存在せず（`logs/`はgitignore対象で、`tokens`/`costUsd`もnull固定）、
構造的に実施不能だった。「変更前に計測を取る」を散文の運用ルールとして追加するだけでは、
[「検知手段のないルールの棚卸し」](./common.md#検知手段のないルールの棚卸しissue-339)の第3層ルールが
1行増えるだけになる（issue #411の原則: 新しい検知メカニズムは起動トリガーが機械か人かを
先に確認する）。よってCIによる機械トリガーで設計した。

- **`scripts/snapshot-agent-baseline.sh`**: `logs/loop-observability.jsonl` /
  `logs/subagent-skeleton.jsonl`（存在すれば`logs/otel-debug-collector.jsonl`の有無も記録）から
  agentType別の実行件数・所要時間を集計し、`docs/agents/baselines/<date>.json`として
  **git管理下**に書き出す（`logs/`がgit管理外であることがissue #419のbefore消失の根本原因の
  ため、集計スナップショットをコミットする形で解消する）。
  - **既知の限界**: `rounds`・`findingCount`はWorkflowの戻り値（`stats`）にのみ存在し、
    現状どのJSONLにも永続化されていない。Workflow完了直後にオーケストレーターが
    `docs/agents/baselines/<date>.json`の`workflowRuns`配列へ手動で追記して補うこと
    （初期値は`docs/agents/baselines/2026-07-16.json`の`workflowRuns`参照）
- **`scripts/check-agent-baseline-freshness.sh`** + `.github/workflows/agent-baseline-check.yml`:
  `.claude/agents/*.md`のfrontmatter`model:`/`effort:`行、または`.claude/workflows/*.js`の
  `opts.model`/`opts.effort`にPR内で差分があるのに、同じPRに`docs/agents/baselines/`の
  更新が含まれていない場合、GitHub Actionsの`::warning::`アノテーションを出す
  （**block ではなく warning のみ**。まずは可視化から始める方針）。issue #422
  （`effort`追加PR）を対象に実行し、警告が正しく出ることを確認済み
- 本仕組みは最初から機械検知（CI）のため、実装後に「検知手段のないルールの棚卸し」表への
  行追加は不要（issue #411の原則どおり）

## Find→Adversarial Verify precision記録（issue #432）

**起票時の前提の訂正:** issue #432は当初「Sweep指摘のprecisionをAdversarial Verify裁定結果
から集計する（追加のLLM呼び出しゼロ）」という想定だったが、`aidd-1-1-deep-task.js`の実装を
確認したところ、Adversarial Verifyが裁定するのはFindフェーズ（仕様書ドラフトへのlogic/data/
security/ux/performance5軸の再発見）の指摘であり、Sweepフェーズ（ui/data/db/types軸の
コードベース調査）の指摘ではないことが判明した（両者は別の生成プロセスで、構造的に1:1対応
しない）。このため実装は「Find指摘のAV生存率」として行った（詳細な理由は
`.claude/workflows/lib/find-av-precision.js`のコメント参照）。

- `aidd-1-1-deep-task.js`の戻り値`stats`に`findAvPrecision`（findCount/verifiedCount/
  survivedCount/autoSurvivedMinorCount/survivalRate/lens別内訳`byLens`）を追加した。
  純粋な集計ロジックの正本は`.claude/workflows/lib/find-av-precision.js`の
  `computeFindAvPrecision`（Workflow DSLはrequire不可のためaidd-1-1-deep-task.js内に
  インライン複製。severity.js等と同じパターン）
- 上記#429の`snapshot-agent-baseline.sh`の「既知の限界」（`rounds`/`findingCount`が戻り値
  にのみ存在しどのJSONLにも永続化されない）と同型の構造的限界を持つ。Workflow DSL自体が
  filesystem API不可のため、フロー完了後にオーケストレーター（Claude Code）が
  `scripts/log-find-av-precision.sh --feature "<feature名>" '<findAvPrecisionのJSON>'`を
  呼んで`logs/find-av-precision.jsonl`へ永続化する必要がある。これは人/エージェント起動の
  第3層ルールであり、呼び忘れを機械的に検知する手段は無い（issue #411原則に照らし、
  今回は機械検知までは実装していない）
- `npm run find-av-precision-summary`（実体は`scripts/summarize-find-av-precision.sh`）で
  feature別・lens別の生存率を集計できる
- **限界**: AV自体もLLM判定でありground truthではない（AVが正しい指摘を誤って棄却する
  ケースはこの指標では測れない）。Sweepの見落とし率（recall）を測る別issue（#431）との
  二本立ての片翼として扱うこと

## Sweep recallベンチマーク（issue #431）

issue #419のような設定変更（effort/model）に対して「精度が落ちていないか」を検証する手段が
無かった。同一タスクのeffort有り/無しA/B比較はground truthが無く「差分」しか測れないため、
既知欠陥を埋め込んだfixtureで見落とし率（recall）を測る仕組みを、issue #391のeval基盤
（`scripts/eval-workflow-prompts.sh`）と同じload-bearing workaroundを再利用して構築した。
[「Find→Adversarial Verify precision記録」](#findadversarial-verify-precision記録issue-432)
（指摘の生存率＝偽陽性側）と対になる、見落とし側の指標。

- `npm run` 経由ではなく `scripts/eval-sweep-recall.sh <layer>`（例: `sweep-ui`）で直接実行する
  （db-implのeval同様、実エージェント呼び出しの課金コストのためCI化は見送り、手動実行）
- fixtureは `scripts/eval-fixtures/sweep-<layer>/case-*/files/` に、既知の失敗パターン
  （[`known-failure-patterns.md`](./known-failure-patterns.md)）を埋め込んだファイルツリーを置く
  形式。db-implのSPEC.md単体コピー方式とは異なり、fixtureごとに任意のファイルツリーをclone先へ
  上書き配置する（sweepは特定のSPEC.mdではなくリポジトリ全体を調査するため）。現在4層それぞれ
  1ケースずつ用意済み: sweep-ui（Suspenseフォールバック未設定）・sweep-data（issue #24型の
  requireAuth欠落）・sweep-db（SECURITY DEFINER + GRANT EXECUTEの認可バイパス）・sweep-types
  （型定義とmapperの層間フィールド不一致）
- 判定は決定的（`expectedFilePathContains`の部分文字列 かつ `expectedKeywords`のいずれか1つが
  sweep出力detailに含まれていればヒット）。LLM judgeは使わない（判定器自体が非決定になると
  回帰テストの意味が薄れるため。issue本文の設計判断）
- プロンプト本文のドリフト対策として、sweepプロンプトの正本を
  `.claude/workflows/lib/prompts/sweep.js` に切り出し、`aidd-phase1.js` /
  `aidd-1-1-deep-task.js` 側のインライン複製との一致を
  `.claude/workflows/lib/__tests__/sweep-prompt-sync.test.js` が検証する（`npm test`に含まれる）
- eval-workflow-prompts.shのload-bearing workaround（`--setting-sources ""` + `--agents`注入、
  `--permission-mode bypassPermissions`、git clone隔離、`--no-session-persistence`、同時実行数
  上限のサーキットブレーカー）をそのまま再利用している
- **実機検証済み（2026-07-17、4層すべてrecall 1/1を確認）**: 当初sweep-db/sweep-typesは実機で
  ミスを検出したが、原因を調査したところharnessではなくfixture設計側の問題と判明し、修正後は
  4層すべてでrecall 1/1を達成した。
  - sweep-db: fixtureのmigrationファイル名が`2999年`という非現実的なタイムスタンプだったため
    注目されにくく、また参照先テーブル`eval_fixture_recall_items`を定義していなかったため、
    「意図した認可チェック欠落」ではなく「テーブル未定義」という別の（意図しない）欠陥に
    注意が逸れていた。タイムスタンプを現実的な値に修正し、参照先テーブル定義を追加して解消
  - sweep-types: 当初のfixtureは`EvalFixtureRecallItem & { internalNote: ... }`という交差型で
    戻り値を宣言しており、TypeScript的には正当な型であるため「型不一致」として弱すぎた。
    宣言型どおりの戻り値型に変更し、余剰プロパティを`@ts-expect-error`で明示する形に修正して
    解消（この状態は実際にTypeScriptの余剰プロパティチェックに引っかかる、より明確な不一致）
  - sweep-typesは同一fixtureで1回目MISS・2回目HITと、実行間で結果が変動した（haikuモデルの
    出力ゆらぎによる残存する非決定性。db-implのcase-4と同種の限界）
- **既知の制約**:
  - sweep-dataは全APIルート・data層を実走査するため、実測で数分〜30分近くかかることがある
    （デフォルトタイムアウトを300→900秒に変更したが、それでも足りない可能性がある）
  - 実エージェント呼び出しのため、Claude Codeのセッション利用上限に達すると実行できなくなる
    （issue #407と同様、このリポジトリ側では制御できない外部制約）
  - モデル（haiku）の出力ゆらぎにより、同一fixtureでも実行のたびにHIT/MISSが変動しうる
    （完全な決定性は保証できない。複数回実行して傾向を見ることを推奨）
- 将来layer・caseを追加する場合は `scripts/eval-fixtures/sweep-<layer>/case-*/` を増やすだけでよい

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
- **運用ルール（義務化・検知機構あり、issue #496。common.mdにも短い版あり）**: `.claude/workflows/*.js` のプロンプト文言を変更したPRでは、マージ前に `npm run eval:workflows <対応するfixtureセット>`（sweep系のプロンプト変更は `scripts/eval-sweep-recall.sh <layer>`）を実行し、結果を引き継ぎメモの「検証済み」欄へ記載すること（未実施の場合はその旨と理由を明記する）。CI化（PR時の自動実行）は引き続き実エージェント呼び出しの課金コストを理由に見送っている。
  - 両スクリプトは実行完了時（pass/fail問わず）に `docs/agents/eval-runs.jsonl`（git管理。`logs/`はgitignoreでbefore消失の前例があるため対象外にした。issue #429と同じ理由）へ日時・fixtureセット名・合否件数を1行追記する。呼び出し側の自己申告ではなくeval script自身が書くため、記録そのものの呼び忘れは起きない（issue #411原則: 起動トリガーは機械）
  - `.github/workflows/eval-runs-freshness-check.yml`（`scripts/check-eval-runs-freshness.sh`、`agent-baseline-check.yml`と同型）が、PRに `.claude/workflows/*.js` の差分があるのに `docs/agents/eval-runs.jsonl` の更新が含まれていない場合に `::warning::` を出す（block ではなく warning のみ）
  - **既知の限界**: 上記が保証するのは「evalスクリプトが最後まで実行されたこと」の痕跡のみであり、実行そのものを強制するものではない（実行し忘れて何もコミットしなければ警告が出るだけで、PRの作成・マージ自体は妨げない）。また記録内容の正しさ（本当にそのfixtureセットに対して実行したか、pass/fail件数が改ざんされていないか）までは検証しない
