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

## 2026-10-19 の実施結果（2 回目・全件）

版 `833d37f9a27c`。前回（2026-09-05）から hook は 24 → 48 登録に増えていたが、実走の版は未記録だった。
手順 1〜2 は scratchpad の runner で機械化した（`.claude/settings.json` から hook を列挙 → このセッションの
transcript を入力に 1 本ずつ実行 → 沈黙は `bash -x` で再実行して最後の分岐を残す）。
runner はリポジトリに入れていない（入れるなら `plugin-layout.json` の配る／配らないの宣言が要る）。

| 群 | 本数 | 出力 | 沈黙（判定到達） | 無音死 | 省略 |
|---|---|---|---|---|---|
| SessionStart + Setup | 25 | 12 | 13 | **0** | 0 |
| Stop | 11 | 2 | 8 | **0** | 1（verify-claims。`claude -p` を呼ぶため） |
| PreToolUse（RED 方向） | 5 | deny 2 / ask 2 / warn 1 | — | **0** | 0 |
| 記録専用・外部に触るもの | 6 | — | — | — | 6（log-subagent-hook-skeleton ×2・log-instructions-loaded・record-test-failure ×2・mark/stop-supabase） |

沈黙した 21 本は、trace の末尾がすべて**判定材料を集めた上での `exit 0`** だった（例: `BEHIND_COUNT=0`、
`STALE_JSON='[]'`、`WF_COUNT=0`、`CHANGED_FILES=''`、`[ -f .aidd/recovery-queue.jsonl ]` が偽）。
ただし Stop の 3 本（aidd-stats / aidd-phase-stats / find-av-precision）は session_id で絞るため、
偽の session_id（マーカーを消費しないために使った）では「このセッションの Workflow 0 件」として黙る。
Workflow を回したセッションで実走しないと、記録漏れ側の判定は測れない（2026-09-05 と同じ限界）。

PreToolUse 5 本は、止める入力で判定が出ることに加えて **`logs/hook-decisions.jsonl` に 5 行**
（`caller: claude`、`rule` は固定語彙）が書かれることを確認した（2026-10-18 導入、`docs/specs/hook-decision-log.md`）。
本物の deny は 2026-10-18 に 1 回（`psql -c "select 1"`）。

| 発見 | 種別 | 症状 | 対応 |
|---|---|---|---|
| `check-hooks-path-alive` の自動復旧の文言 | **事実を越えた報告** | worktree スコープの上書きの先が**実在していた**（hook は動いていた）のに「git hook が動いていませんでした。直前のコミット・push は hook を通っていない可能性」と断定した | 直す前の先が実在したかで分岐（`WAS_DEAD`）。test の scenario 3 / 4 に対を足した（本 PR） |
| worktree スコープの `core.hooksPath`（メイン checkout の絶対パス）が**再び**入っていた | 環境（外部要因） | リポジトリのスクリプトは worktree スコープを書かない（`install-git-hooks.sh` は local・相対）。worktree を作る側（アプリの EnterWorktree）が入れている可能性 `[要確認]`。4 回目。自動復旧が外した（いまは `local scripts/git-hooks`） | 観察のみ。発生源の特定は別件 |
| `record-test-failure` が `ls …test.sh` の失敗を「落ちた検査」に数える | 設計どおりの粗さ | コマンド文字列に `test` を含めば検査扱い。`check-escape-ledger` に「（テスト名を拾えず）」が 3 件並んだ | 設計どおり（拾うだけ拾い、人が仕分ける）。`triage-escapes.sh --none` で記録した |
| ドリルの runner 自身の誤り | **C-025 の型（不在を対象外と読む）** | jq の出力を tab 区切りで読んだため、matcher が空の行で欄が詰まり **Stop 以降が丸ごとスキップ**された。1 回目の結果表には Stop が無く、無いことに気づかず「終わった」と読みかけた | 区切りを US 文字にして再実行。**件数の期待値（settings.json の登録数 48）と結果表の行数を突き合わせる**のを手順に足すべき |

### hook 一覧と 2026-10-19 の判定（沈黙したもののみ。出力したものは「出力あり・内容妥当」）

| イベント | hook | 判定 | 最後に通った分岐 |
|---|---|---|---|
| SessionStart | check-branch-tool-ownership | 正常 | ブランチ `claude/*` と tool `claude` が一致 |
| SessionStart | check-local-main-freshness | 正常 | FETCH_HEAD 13h・behind 0 |
| SessionStart | check-otel-collector-status | 正常 | opt-in 未設定 |
| SessionStart | check-blocked-issues-staleness | 正常 | blocked 1 件、90 日未満 |
| SessionStart | check-fault-injection-drill-staleness | 正常 | 期限前 |
| SessionStart | check-workflow-interruption | 正常 | project dir に `wf_*.json` なし |
| SessionStart | check-recovery-queue | 正常 | キュー無し |
| SessionStart | check-claude-md-size | 正常 | 16,104 文字（上限 24,000） |
| SessionStart | check-empty-session-report | 正常 | 未コミットの sessions 無し |
| SessionStart | check-access-review-staleness | 正常 | 期限前 |
| SessionStart | check-subagent-model-force | 正常 | 3 つの settings に変数なし |
| SessionStart | check-plugin-integrity | 正常（7 秒） | 4 プラグインの manifest と実物が一致 |
| SessionStart | check-hook-dependencies | 正常 | doctor: registrations=57 unresolved=0 notExecutable=0 |
| Stop | check-domain-decisions-suggest | 正常 | 変更ファイル無し |
| Stop | ai-check-suggest | 正常 | 変更ファイル無し（.ts/.tsx/.sql なし） |
| Stop | gate-effectiveness-monthly-check | 正常 | 収穫は実行、通知は 30 日未経過 |
| Stop | check-gap-check-state | 正常 | state 無し |
| Stop | check-aidd-stats-recorded | 正常（限界あり） | 偽 session_id で WF_COUNT=0 |
| Stop | check-aidd-phase-stats-recorded | 正常（限界あり） | 偽 session_id の workflows dir 無し |
| Stop | check-handoff-format | 正常 | transcript から PR #896 を拾い、必須見出し・04 表・依存変更の記述を評価して違反なし |
| Stop | check-find-av-precision-recorded | 正常（限界あり） | 偽 session_id の workflows dir 無し |

出力があった 14 本（hooks-path-alive・branch-pr-status・automode-config・stale-worktrees・upstream-docs/
dependency-update の期限超過・鮮度 4 本・reinject・maintenance-digest・full-run-before-finish・escape-ledger）は、
いずれも内容がいまの状態と一致していた（例: branch-pr-status は PR #896 でマージ済みのブランチを正しく名指し）。
hooks-path-alive だけが上表のとおり文言が事実を越えていた。

## 実走した版（2026-09-11 に追加）

「hook を変えたら回す」という目安は書いてあったが、**変わったかどうかを誰も見ていなかった**
（期限＝四半期だけが `scripts/maintenance-digest.sh` に載っていた）。版で見る。

最後に実走した版: `833d37f9a27c`（2026-10-19、全件）
この仕組みを入れた時点の版: `4e16c913748b`（2026-09-11）

- 版は `node scripts/lib/hook-registry-hash.mjs --root .` が出す。
  見るのは**配線**——どの hook が・どのイベントに・どのコマンドで登録されているか。
  対象は **Claude 側（`.claude/settings.json`）と Codex 側（`.codex/hooks.json`）の両方**。
- `.codex/hooks.json` には 8 本の hook があり、うち 3 本は deny（DDL 実行・依存追加・skip marker）。
  **止める側が黙って死ぬほうが危ない**ので、Codex 側も版に入れる。
- **スクリプトの中身は版に入れていない。** 最初は入れたが、`maintenance-digest.sh` 自身が
  登録された hook なので**この仕組みを書いている最中に版が変わった**。hook はふだんの開発でよく
  触るので、中身まで見ると毎回鳴る——**毎回鳴る警告は読まれなくなる**。
  実測（2026-09-11）: 登録されたスクリプトへ 1 行追記しても版は `4e16c913748b` のまま、
  Codex の PreToolUse から deny を 1 本外すと `561c576724df` に動いた。
  **ある hook のロジックを書き換えたときは、目安どおり自分でその hook を実走すること。**
- **2026-09-05 の実走は版を残していない**ので、そこから何が変わったかは遡れない。
  次の実走のときに「最後に実走した版」をその日の版で書き換えること。
- 版が動いても**実機で発火するか**は測れない（それがこのドリルの役目）。版は「やり直す合図」まで。

## 次回実施の目安

- `.claude/settings.json` または `.codex/hooks.json` の hooks を追加・変更したとき（その hook のみ）。
  変わったことは上の「実走した版」で機械が見る
- Claude Code 本体のメジャー更新後（transcript / `wf_*.json` の形式が変わりうる）
- プラグイン v1 の切り出し前と、各バージョンのリリース前（全件）

## 次回実施予定日

2027-01-19（四半期後の目安。v1 の切り出し前は予定日を待たず全件実施する。実施後に手動で書き換える。
期限は `scripts/maintenance-digest.sh`（`claude -p --maintenance`、issue #741）が他の定期作業と
まとめて表示する）
