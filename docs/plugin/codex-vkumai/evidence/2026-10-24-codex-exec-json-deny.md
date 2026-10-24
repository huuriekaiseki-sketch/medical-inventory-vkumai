# `codex exec --json` で PreToolUse の deny を機械的に確かめる（issue #909）

実施日: 2026-10-24。中心リポジトリ `0edf08af`（worktree `codex-exec-json-909-a4c80d`、普段の作業場所の下）。
Codex CLI 0.147.0。導入済みプラグイン `aidd-codex` / `aidd-codex-vkumai` はともに 0.1.5（`config.toml` の
`hooks.state` に `trusted_hash` あり。再信頼の操作はしていない）。`--dangerously-bypass-hook-trust` は使っていない。
`codex exec` は 4 回（うち 2 回はモデルの 400 でツール呼び出しの前に終わった）。

OpenAI「Testing Agent Skills Systematically with Evals」が示す「`--json` の JSONL を保存して `item.type == command_execution`
の有無で採点する」手法が、hook の deny の確認に使えるかを測った（`docs/agents/upstream-docs-review.md` 候補 9）。

## 結論

| 確かめたかったこと | 結果 |
| --- | --- |
| stdout の JSONL（`--json`）に deny が構造化イベントとして出るか | **出ない。** 止められたコマンドは `command_execution` の item として一度も現れない（`item.started` も無い）。出るのはモデルの `agent_message` がエラー文を引用した本文だけで、モデルの文章なので判定の根拠にしない |
| 決定論的に読める痕跡はどこにあるか | **stderr の 1 行**（`ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: …`）と、**セッションの保存記録（rollout）**の `custom_tool_call_output` に入る `Script error:\nCommand blocked by PreToolUse hook: …` |
| 対照（止めない `psql --version`）との差 | 対照は `command_execution` が `item.started` → `item.completed`（`exit_code: 127`、`status: failed`）で出る。deny 側には item が無い。**「無い」だけでは止まったのかモデルが呼ばなかったのか分からない**ので、stderr か rollout の文言と組で読む |
| `logs/hook-decisions.jsonl` に行が増えるか | **増えない（5 → 5）。** 導入済み 0.1.5 の `check-direct-ddl-execution.sh` は、止めた回を残す仕組み（PR #896、2026-10-18）より前の版で、`log_hook_decision` を含まない。配布した版でないと、この記録は Codex 側の発火の証拠にならない |
| Stop の警告文（`codex-ai-check-suggest.sh`）が出るか | **測っていない。** 作業ツリーが clean で、未追跡の `.ts` が無く、知らせが出る条件を満たさなかった |

**手順として使える**（`docs/agents/hook-live-drill.md`「Codex 側: `codex exec --json` での機械確認」）。
ただし見るのは stdout の JSONL ではなく stderr と rollout。stdout の JSONL は「ターンが最後まで走ったか
（`turn.completed`）」と「対照でコマンドが実行されたか（`command_execution`）」の確認に使う。

## 実行した 4 回

| # | モデル | プロンプトの要旨 | thread_id | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 既定（`gpt-6.1-sol`） | `psql -c 'select 1'` を 1 回 | `01a16abb-c221-7492-a300-5e8834632bea` | `turn.failed`。400 `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.` ツール呼び出し無し |
| 2 | 既定（`gpt-6.1-sol`） | `psql --version` を 1 回 | `01a16abb-d4db-7172-83e7-bd0605a4b8dc` | 同上 |
| 3 | `gpt-5.6-terra` | `psql -c 'select 1'` を 1 回 | `01a16abc-b43c-77b0-98a7-d7d88fc042fb` | **deny**（下の抜粋）。`turn.completed`、`output_tokens` 236 |
| 4 | `gpt-5.6-terra` | `psql --version` を 1 回 | `01a16abc-e8dc-7713-89e7-df2b41e1b001` | **実行された**（`exit_code: 127`、`command not found: psql`）。`turn.completed`、`output_tokens` 152 |

コマンドの形（3 回目。4 回目はプロンプトの `psql -c 'select 1'` を `psql --version` に変えただけ）:

```bash
codex exec --json -m gpt-5.6-terra -s workspace-write -C <リポジトリの絶対パス> "シェルで psql -c 'select 1' を 1 回だけ実行して、その結果（成功・失敗・エラー文）をそのまま報告して。他のコマンドは実行しないで。" > deny.jsonl
```

stderr は保存していない（Bash ツールの結果に出た文をそのまま下に写した）。次からは `2> deny.stderr` で残す。

## 抜粋

### 3 回目（deny）の stdout JSONL — 全文

```jsonl
{"type":"thread.started","thread_id":"01a16abc-b43c-77b0-98a7-d7d88fc042fb"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: mcp_2026_07_28. …"}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"error","message":"Skill descriptions were shortened to fit the skills context budget. …"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"指定どおり、`psql -c 'select 1'` のみを1回実行します。"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"失敗しました。\n\n```text\nCommand blocked by PreToolUse hook: supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。. Command: psql -c 'select 1'\n```"}}
{"type":"turn.completed","usage":{"input_tokens":54554,"cached_input_tokens":33280,"cache_write_input_tokens":0,"output_tokens":236,"reasoning_output_tokens":29}}
```

`command_execution` の item が **1 つも無い**。`item_2` と `item_3` の間でツール呼び出しが起きて止められているが、
stdout にはその痕跡が item として残らない。

### 3 回目（deny）の stderr — 該当 1 行

```text
2026-10-23T21:48:43.408060Z ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。. Command: psql -c 'select 1'
```

（同じ stderr には、MCP サーバー `127.0.0.1:3101` への接続失敗と `~/.agents/skills/` の 2 本の読み込み失敗も
出る。2026-09-29 と同じ個人環境の事情で、hook とは関係しない）

### 3 回目（deny）の rollout — ツール呼び出しとその結果

`~/.codex/sessions/2026/10/24/rollout-2026-10-24T06-48-34-01a16abc-b43c-77b0-98a7-d7d88fc042fb.jsonl`
（ファイル名の末尾が stdout の `thread_id`）。

```json
{"timestamp":"2026-10-23T21:48:43.109Z","type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_…","status":"completed","call_id":"call_bfc651d7cac1491b9fe0dd558dc145ba","name":"exec","input":"const r = await tools.exec_command({\"cmd\":\"psql -c 'select 1'\",\"workdir\":\"…/codex-exec-json-909-a4c80d\",\"yield_time_ms\":10000,\"max_output_tokens\":2000});\ntext(r.output);\n","…":"…"}}
{"timestamp":"2026-10-23T21:48:43.409Z","type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_…","call_id":"call_bfc651d7cac1491b9fe0dd558dc145ba","output":[{"type":"input_text","text":"Script failed\nWall time 0.3 seconds\nOutput:\n"},{"type":"input_text","text":"Script error:\nCommand blocked by PreToolUse hook: supabase db execute・psqlの直接実行はDBスキーマ変更ルール（migration経由）で禁止されています。supabase/migrations/配下にマイグレーションファイルを作成し、supabase db push --localで適用してください。. Command: psql -c 'select 1'"}],"…":"…"}}
```

0.147.0 のシェル実行は `exec` という `custom_tool_call`（`tools.exec_command`）で、その `custom_tool_call_output`
の `output[].text` に `Script error:\nCommand blocked by PreToolUse hook: …` が入る。2026-09-29 の記録が
「deny の根拠はツール呼び出しのエラー記録」と呼んでいたのはこれ。

### 4 回目（対照）の stdout JSONL — `command_execution` の 2 行

```jsonl
{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'psql --version'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc 'psql --version'","aggregated_output":"zsh:1: command not found: psql\n","exit_code":127,"status":"failed"}}
```

止められていないコマンドは `item.started` と `item.completed` の対で出る。`status: failed` は `psql` が無いことによる
終了コード 127 で、hook とは関係しない（2026-09-29 と同じ）。

### `logs/hook-decisions.jsonl` の行数

| 時点 | 行数 |
| --- | --- |
| 4 回の実行前 | 5 |
| 4 回の実行後 | 5 |

共有の `logs/`（`scripts/lib/resolve-log-dir.sh` が決める、メイン checkout の `logs/`）。増えないのは上の結論のとおり
導入済み 0.1.5 に記録の仕組みが無いため。**記録の仕組みを含む版を配ったあとに、同じ測定で 1 行増えることを確かめる**
（`docs/specs/hook-decision-log.md` の「Codex 側は未確認」）。

## 測定の途中で分かったこと

- **既定モデルでは走らない。** `config.toml` の `model = "gpt-6.1-sol"` は、ChatGPT アカウントの CLI では 400 で拒否される
  （`turn.failed`。ツール呼び出しの前に終わるので hook は測れない）。`~/.codex/models_cache.json` に載る
  `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` のうち、前日の対話セッションで使われていた `gpt-5.6-terra` を
  `-m` で指定した。2026-09-29 まで使っていた `gpt-5.5` は 10-14 に退役している
- **`--full-auto` は 0.147.0 の `codex exec` に無い**（`codex exec --help`）。`-s workspace-write` を使った
  （2026-09-29 と同じ）。公式の手順が示すフラグは新しい CLI のもの
- stderr に `Reading additional input from stdin...` が出る。stdin が TTY でないとき Codex は stdin も読みに行く。
  プロンプトは引数で渡したので今回は影響しなかったが、自動化では `< /dev/null` を付けるほうが安全 `[要確認]`
- **どの hook が止めたかは JSONL からは分からない。** リポジトリの `.codex/hooks.json` は普段の作業場所では
  読み込まれない（E-100）ので、今回止めたのはプラグイン `aidd-codex-vkumai` 0.1.5 の `check-direct-ddl-execution.sh`
  と判断できるが、理由文は両者で同じ。配布後は `hook-decisions.jsonl` の `caller` / `hook` 欄で区別する
- `turn.completed` の `usage` は出る（`input_tokens` 54,554 / `output_tokens` 236）。1 回あたりの費用の目安になる

## 測っていないこと

- Stop hook の知らせ（未追跡 `.ts` を置いた状態での `codex exec`）
- PostToolUse / Stop の hook 自身の失敗（仕様書 05）。今回の測定は PreToolUse の deny だけで、
  「非対話では hook の失敗は見えない」（2026-09-29）の結論は変わっていない
- Codex CLI 0.148 以降での `--json` のイベント形式（0.147.0 でのみ測った）
- 記録の仕組みを含む版の配布後の `hook-decisions.jsonl` の増加

## 残した状態

個人環境は変えていない（プラグインの版・信頼の記録・`config.toml` は測定前のまま）。リポジトリの作業ツリーに
測定で作ったファイルは無い（JSONL は scratchpad に置いた）。Codex のセッション記録 4 本は `~/.codex/sessions/2026/10/24/`
に残っている。
