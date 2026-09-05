# hook 実走ドリル（眠っている検知の生存確認）

`.claude/settings.json` に登録された hook は、ほぼすべてが **fail-open**（判定材料が取れなければ沈黙）
かつ **warning-only** で設計されている。この組み合わせは「壊れても何も起きない」ため、hook 自身には
壊れたことに気づく手段が無い。構造テスト（`scripts/*.test.sh`）はスクリプトの判定ロジックを固定するが、
「本物の入力が想定した形で来ているか」「前提にした運用がまだ続いているか」までは検証できない。

このランブックは、**現在のセッションの実データを各 hook に食わせ、判定経路に到達しているかを確認する**
手順と、実施結果の記録場所を定める。プラグイン v1 として切り出す前に、眠っている仕組みを一度全部
動かして潰す方針（`docs/agents/decisions.md` 参照、issue #420）の中核作業。

## 2026-09-05 の実施結果（初回）

7 月以来一度も実走していなかった仕組みを動かしたところ、1 日で **7 件の無音死・空振り**が見つかった。
いずれも構造テストは GREEN のままだった。

| 発見 | 種別 | 症状 | 修正 |
|---|---|---|---|
| Stop hook 3 本（#495 #522 #524）が transcript 1 行目の `timestamp` 決め打ち | 入力形式の変化 | Remote Control 連携セッションの transcript は timestamp 無しの `bridge-session` 行で始まり、開始時刻が取れず沈黙。deep-task が 61 件検証しても記録漏れ警告が出なかった | PR #728。先頭 50 行のうち最初に timestamp を持つ行を採用 |
| eval-runs 鮮度チェックの `::warning::` | 届かない警告 | 3 PR で正しく出ていたが run を開かないと見えず、全件無視されて記録が 7/23 で停止 | PR #729。失敗（exit 1）化、免除は本文の `eval-skip:` |
| sweep recall fixture が「ベンチマーク用・意図的に再現」と自己申告 | fixture の欠陥 | エージェントが欠陥に気づいた上で「意図的」として指摘から外し MISS | PR #732。コメント削除、NOTES.md へ分離、中立性テスト |
| recall ハーネスが非 JSON 応答を空として判定 | ハーネスの欠陥 | 欠陥を報告しているのに MISS | PR #732。生出力 fallback |
| recall 判定器が層をまたぐ欠陥の片側ファイルしか正解にしない | 判定器の欠陥 | 型定義側を指した正しい報告が MISS | PR #732。期待パスの配列 |
| handoff 形式検知が「Stop 時点の現在ブランチ」で PR を探す | 運用手順の変化 | PR を作ってマージし main へ戻る運用では 14 本作っても 1 本も評価されず沈黙 | PR #734。transcript の tool_result から PR 番号を取る |
| autoMode 警告文が #486 で移動済みの節を指す | docs 参照の腐敗 | 「common.md の推奨設定」が存在しない | PR #735。参照修正＋hook 文言の docs 参照検査テスト |

副産物として、`show-agent-status.sh` が 40 日前の残骸を毎回再注入していた件（PR #727）、
`check-hook-doc-pointers.test.sh` 自身が BSD grep のロケール問題で空振りしていた件（同 PR 内で修正）も
同じ「動かして初めて分かる」型だった。

## 手順

### 1. 現在セッションの hook 入力を作る

hook は stdin で JSON を受け取る。`session_id` と `transcript_path` があれば大半の hook は動く。
transcript のパスは `~/.claude/projects/<cwd を - に置換した名前>/<session_id>.jsonl`。

```json
{"session_id":"<session_id>","transcript_path":"/Users/<you>/.claude/projects/<project-dir>/<session_id>.jsonl","cwd":"<worktree の絶対パス>","hook_event_name":"Stop","source":"startup"}
```

これを scratchpad に `hook-input.json` として置く（リポジトリ内には置かない）。

### 2. 各 hook を単体実行し、沈黙なら `bash -x` で判定経路を見る

```bash
bash scripts/<hook>.sh < hook-input.json
bash -x scripts/<hook>.sh < hook-input.json
```

**沈黙は 2 種類ある。** 「判定材料を集めた上で報告事項なし」（正常）と「判定材料が取れず早期 exit」
（fail-open の無音死）。`bash -x` で最後に通った分岐を見て区別する。判定材料に到達しているなら
正常。`[ -n "$X" ] || exit 0` の類で抜けているなら、その X が「今の実データで取れない」理由を追う。

副作用があるもの（マーカー・seen ファイル・キュー）は環境変数で scratchpad に逃がす。
各 hook の先頭コメントに「テスト用の注入ポイント」として一覧がある。

### 3. RED 方向（本来止める・警告すべき入力）も 1 つ与える

PreToolUse の deny / ask は、止めるべき入力の JSON（`tool_name` / `tool_input`）を作って流す。
実際のツールは実行しない（`supabase db push` を本当に打たない）。Stop / SessionStart の警告系は、
過去の実データ（killed な `wf_*.json`、verifiedCount>0 の run など）を `*_PROJECT_ROOT` /
`*_WORKFLOWS_DIR` の注入ポイントで指して、警告が出ることを見る。

### 4. 記録

結果は本ファイルの「実施結果」に追記し、見つかった型は `docs/agents/known-failure-patterns.md`
「fail-open の warning-only hook が、入力形式の変化で無音のまま死ぬ」に足す。

## hook 一覧と 2026-09-05 の判定

| イベント | hook | 判定 | 備考 |
|---|---|---|---|
| SessionStart | check-branch-pr-status | 正常（判定到達・報告なし） | `gh pr list --head <branch> --state merged` |
| SessionStart | check-branch-tool-ownership | 起動時に発火確認 | |
| SessionStart | check-local-main-freshness | 正常（FETCH_HEAD 0h・behind 0） | |
| SessionStart | check-otel-collector-status | 正常（opt-in 未設定で早期 exit は設計どおり） | |
| SessionStart | check-automode-config | 警告あり。**文言の参照先が移動済み** → 修正 | |
| SessionStart | check-blocked-issues-staleness | 正常（blocked 1 件、90 日未満） | |
| SessionStart | check-fault-injection-drill-staleness | 正常（次回予定日前） | |
| SessionStart | check-upstream-docs-review-staleness | 導入時（2026-09-05）に実態ファイルで沈黙・過去日 fixture で警告を確認 | 公式 docs 差分確認の期限監視 |
| SessionStart | check-subagent-model-force | 導入時（2026-09-05）に実環境で沈黙（変数未設定）・`env CLAUDE_CODE_SUBAGENT_MODEL_FORCE=haiku` で警告を確認 | AIDD モデル階層の無効化検知（issue #743） |
| SessionStart | check-workflow-interruption | 正常。killed 記録を注入すると復旧キューへ登録 | 表示は recovery-queue 側 |
| SessionStart | check-recovery-queue | 正常（キュー無し） | |
| SessionStart | check-claude-md-size | 起動時に発火確認（上限内） | |
| SessionStart | check-stale-worktrees | 警告あり（残骸 2 件、正しい） | |
| SessionStart | check-empty-session-report | 正常（未コミットの sessions 無し） | |
| SessionStart(compact) | reinject-aidd-run-state | 実 compaction で発火確認（#712） | 40 日前の残骸混入 → PR #727 |
| Setup(maintenance) | maintenance-digest | `claude -p --maintenance --debug` で発火確認（debug ログに `Hook Setup:maintenance (Setup) success` とダイジェスト本文。1 ターン約 $0.21） | 同時に個人プラグイン claude-mem 10.6.3 の Setup hook が `setup.sh: No such file` を出す（リポジトリ外） |
| PreToolUse | check-skip-marker-write | RED: Write / cwd 相対 touch とも ask | |
| PreToolUse | check-dependency-change | 実機で ask 確認（`npm install foo`、別セッション） | |
| PreToolUse | check-run-manifest-presence | 高リスクパス編集で警告発火を確認（fixture 編集時） | |
| PreToolUse | check-direct-ddl-execution | RED: 素の `db push` / MCP execute_sql は deny、`--local` は通過 | |
| PreToolUse | check-readonly-bash | 実機 deny 確認済み（#713） | |
| SubagentStart/Stop | log-subagent-hook-skeleton | 記録あり。**app 内部の subagent（agentType 空）も記録される** | 集計側は wf_ パスで絞るため影響なし |
| InstructionsLoaded | log-instructions-loaded | 導入時（2026-09-05、2.1.258）に `claude -p` で実発火を確認。3 件（個人 CLAUDE.md=session_start / CLAUDE.md=session_start / common.md=**include**）。project 配下 22,975 文字は `check-claude-md-size.sh` の自前計算と完全一致。**`memory_type` の実値は docs の `instructions` でなく `User` / `Project`**（docs 差分） | 記録専用（公式仕様で出力は全て無視される）。paths 付き rules は起動時に来ない（設計どおり） |
| Stop | check-domain-decisions-suggest | 空 systemMessage | 害は未確認（下記） |
| Stop | ai-check-suggest | 空 systemMessage | 同上 |
| Stop | verify-claims | 観測ログが当日更新 → 生存 | 実走は課金のため省略 |
| Stop | gate-effectiveness-monthly-check | 空 systemMessage（30 日未経過） | |
| Stop | check-gap-check-state | 正常（state 無し） | |
| Stop | check-aidd-stats-recorded | **bridge-session で無音死** → PR #728 | |
| Stop | check-aidd-phase-stats-recorded | 同上 → PR #728 | |
| Stop | check-handoff-format | **マージ後 main で無音死** → PR #734 | |
| Stop | check-find-av-precision-recorded | **bridge-session で無音死** → PR #728 | |
| Stop | harvest-journal-events | 正常。ただし project dir 43 件を毎回走査（2.8 秒・node 43 起動） | 改善候補 |

同日中に対応した観察（issue #737 / #738）:
- 3 つの Stop hook が `{"systemMessage": ""}` を返していた。公式仕様は「表示しないなら systemMessage を
  省略する」で、空文字の扱いは未定義だったため、報告事項なしは無出力に揃えた（他の Stop hook と同じ）
- `harvest-journal-events.sh` は全 worktree の project dir（43 件）を毎 Stop で走査していた。前回収穫
  （state ファイルの mtime）より新しいファイルを `wf_*` 配下に持つ dir だけ node を起動する形にし、
  収穫 0 件の dir は出力しない

## 2026-09-05 プラグイン経由の実走（issue #420 v1 受け入れ条件）

生成物（`dist/plugins/aidd-core` / `aidd-vkumai`）を検証リポジトリ（git init 直後）に `--plugin-dir` で
読み込み、`claude -p --debug` 1 ターン（$0.11）と `aidd-vkumai:aidd-phase1` 実走（$0.41）で確認した。
リポジトリ内で GREEN だった hook が、配布形態が変わると無音死する型が 2 件出た。

| 発見 | 種別 | 症状 | 修正 |
|---|---|---|---|
| 生成した plugin.json の `hooks: "./hooks/hooks.json"` | 配布形態の変化 | `hooks/hooks.json` は自動で読まれるため「Duplicate hooks file detected → Hook load failed」。hook 自体は発火していたが plugin が load-failed 扱い | manifest から `hooks` を外す（build-plugin.mjs） |
| hook 15 本の `cd "$(dirname "$0")/.."` | 配布形態の変化 | プラグインではスクリプト位置がプラグインルートになり、Stop hook の状態ファイル・`resolve_log_dir` の解決先が導入先でなくなる（月次サマリが中心リポジトリの `logs/` を読んでいた） | `cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"`（hook は CLAUDE_PROJECT_DIR を受け取る。無ければ従来どおり） |

修正後の再実走で確認できた範囲: SessionStart 13 本（core）＋ automode（vkumai）、Stop 8 本、
InstructionsLoaded、SubagentStart/Stop（phase1 実走時）。状態ファイル（ai-check-suggest / domain-decisions-suggest / verify-claims の各 state ディレクトリ）と
ログは検証リポジトリ側に書かれた。PreToolUse 5 本（run-manifest /
skip-marker / readonly-bash / dependency-change / direct-ddl）は検証リポジトリで Write / Bash を伴う
操作をしていないため未実走（構造テストと中心リポジトリでの実機 deny 確認のみ）。

## 次回実施の目安

- `.claude/settings.json` の hooks を追加・変更したとき（その hook のみ）
- Claude Code 本体のメジャー更新後（transcript / `wf_*.json` の形式が変わりうる）
- プラグイン v1 の切り出し前と、各バージョンのリリース前（全件）

## 次回実施予定日

2026-12-05（四半期後の目安。v1 の切り出し前は予定日を待たず全件実施する。実施後に手動で書き換える。
期限は `scripts/maintenance-digest.sh`（`claude -p --maintenance`、issue #741）が他の定期作業と
まとめて表示する）
