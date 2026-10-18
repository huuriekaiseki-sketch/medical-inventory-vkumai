# SPEC: 止める hook が「止めた」ことを 1 行残す（hook-decisions.jsonl）

- feature: `hook-decision-log`
- 重要度: 中 / 影響: Claude Code・Codex の PreToolUse hook 5 本（判定そのものは変えない）
- 状態: 2026-10-18 承認（決めてほしいこと 1〜6 はすべておすすめの通り）。スクリプトとテストは実装済み。実機（Claude Code / Codex の本物の hook 入力）での確認は未実施

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

ツールの実行を**止める・確認を挟む・警告する** hook が、そうした回を 1 行ずつ機械的に残すようになります。

いまは、止める力を持つ hook 5 本のどれも、止めたことをどこにも書いていません。`logs/` には
記録が 9 種類ありますが、「hook が何を何回止めたか」を数えられるものは 1 つも無く、
唯一それに近い `docs/agents/harness-score.jsonl`（28 行）は issue を閉じるときに人が書く自己申告です
（2026-10-18 の棚卸し。`verify-claims-observability.jsonl` は 2,617 件中 2,563 件が fail_open で、
「止めた」ではなく「動いていなかった」の記録）。

この 1 行があると、次のことができるようになります。

- 「この 1 か月で hook が何を何回止めたか」を機械で数える（可視化の元データ）
- 「止めているはずの hook が、実は一度も発火していない」に気づく（verify-claims と同じ型の無音死の検知）
- `harness-score.jsonl` の `stopped` 行を書くとき、人の記憶ではなく記録から引く

## 対象の hook

| hook | 判定 | 呼ぶ側 |
| --- | --- | --- |
| `check-direct-ddl-execution.sh` | deny | Claude Code 直接 / Codex 直接 |
| `check-readonly-bash.sh` | deny | Claude Code 直接（サブエージェントの `agent_type` があるときだけ） |
| `check-skip-marker-write.sh` | ask | Claude Code 直接 / Codex は `codex-skip-marker-deny.sh` 経由（ask→deny） |
| `check-dependency-change.sh` | ask | Claude Code 直接 / Codex は `codex-dependency-change-deny.sh` 経由（ask→deny） |
| `check-run-manifest-presence.sh` | warn（allow + additionalContext） | Claude Code 直接 |

## 操作の流れ

| 状態 | いま | 変更後 |
| --- | --- | --- |
| hook が deny を返す | deny。記録なし | deny。**`logs/hook-decisions.jsonl` に 1 行** |
| hook が ask を返す | ask。記録なし | ask。1 行 |
| hook が warn（allow + 注記）を返す | 注記。記録なし | 注記。1 行 |
| hook が黙って通す（allow） | 通す | 通す。**記録しない**（決めてほしいこと 1） |
| 記録先に書けない（ディレクトリ不可・jq 無し） | — | **判定はそのまま出す。記録だけ黙って飛ばす**。stdout・exit code は 1 文字も変えない |
| Codex のラッパーが ask→deny に読み替える | 読み替え | 読み替え。記録は正本が書き、`caller: "codex"` が付く（記録上の decision は `ask` のまま。集計側で読み替える） |

## 1 行の形

```json
{"timestamp":"2026-10-18T01:23:45Z","hook":"check-direct-ddl-execution","decision":"deny","rule":"db_push_without_local","tool_name":"Bash","target":"supabase","caller":"claude","agent_type":"","session_id":"c712f376-…","branch":"claude/vkumai-three-tasks-143744"}
```

| 項目 | 必須 | 中身 |
| --- | --- | --- |
| `timestamp` | 必須 | UTC、秒まで |
| `hook` | 必須 | スクリプト名（拡張子なし）。**同じ hook は同じ名前**（harness-score の部品名と同じ考え） |
| `decision` | 必須 | `deny` / `ask` / `warn` の 3 値だけ |
| `rule` | 必須 | どの規則に当たったか。固定語彙（下表）。文言は変わるが語彙は変えない |
| `tool_name` | 必須 | hook 入力の `tool_name`（`Bash` / `Write` / `Edit` / `MultiEdit` / `apply_patch` / `mcp__…`） |
| `target` | 必須（空可） | Bash は**実行されようとした先頭の語だけ**（`psql` / `supabase` / `npm`）。Write 系はファイルパス。**コマンド本文は残さない**（決めてほしいこと 2） |
| `caller` | 必須 | `claude` / `codex` / `unknown`（決めてほしいこと 5） |
| `agent_type` | 任意 | hook 入力の `agent_type`（サブエージェント内のときだけ入る。`check-readonly-bash` の判定根拠） |
| `session_id` | 任意 | hook 入力の `session_id`。取れなければ空 |
| `branch` | 任意 | 実行時のブランチ。取れなければ `unknown` |

`rule` の語彙:

| hook | rule |
| --- | --- |
| check-direct-ddl-execution | `npx_supabase` / `direct_exec` / `db_push_without_local` / `mcp_execute_sql` |
| check-readonly-bash | `readonly_role` |
| check-skip-marker-write | `skip_marker` |
| check-dependency-change | `dependency_change_command` / `dependency_change_file` |
| check-run-manifest-presence | `manifest_missing` |

## 受け入れ条件

印の意味: ✅ スクリプト単体のテストで確認済み / 🟡 一部 / ⬜ 未実施

- ⬜ 5 本それぞれで、止める入力を与えると記録が 1 行増え、`hook` / `decision` / `rule` が上の語彙で入っている
- ⬜ 対: 通す入力では記録が増えない（ファイルも作られない）
- ⬜ 5 本それぞれで、記録先を書けない状態にしても deny / ask / warn の出力と exit code が**変更前と同一**（RED 方向）
- ⬜ `psql "postgres://user:pass@host/db"` を止めた行に `pass` が含まれない（`target` は `psql` だけ）
- ⬜ Codex ラッパー 2 本を通した行は `caller: "codex"`
- ⬜ 記録先は `resolve_log_dir` 経由（`scripts/check-log-dir-resolution.test.sh` scenario 1 が緑のまま）
- ⬜ 既存の `.test.sh`（5 本＋ラッパー 2 本）がすべて緑のまま
- ⬜ 配布（`plugin-layout.json`）に新しい部品が登録され、`build-plugin.test.sh` が緑

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 | 状態 |
| --- | --- | --- | --- | --- |
| 1 | 記録する範囲 | deny / ask / warn のみ。allow は書かない | 「止めた回数」を数えたいだけなら十分。allow も書くと Bash 1 回で 5 行増える | 承認（2026-10-18） |
| 2 | `target` に残す本文 | 先頭の語だけ | 接続文字列のパスワード等が記録に残る余地を無くす。何を止めたかは `rule` で読む | 承認（2026-10-18） |
| 3 | 置き場 | 共有 `logs/hook-decisions.jsonl`（git 管理外） | 他の機械記録と同じ場所・同じ解決方法。人が書く `harness-score.jsonl` と混ぜない | 承認（2026-10-18） |
| 4 | 保持 | ローテーションなし・追記のみ | 止めた回しか書かないので月に数十行の見込み。1 万行を超えたら考える | 承認（2026-10-18） |
| 5 | `caller` の決め方 | 環境変数 `AIDD_HOOK_CALLER` があればその値（Codex ラッパー 2 本が `codex` を渡す）。無ければ `tool_name` が `apply_patch` なら `codex`、`CLAUDE_PROJECT_DIR` があれば `claude`、どれでもなければ `unknown` | Codex が `check-direct-ddl-execution.sh` を**直接**呼ぶ経路にはラッパーが無い。確実に分かる手がかりだけで決め、分からなければ `unknown` と書く（当てずっぽうで `claude` にしない） | **要確認** |
| 6 | 記録の失敗を知らせるか | 知らせない（黙って飛ばす） | 知らせると hook の stdout が変わり、判定の契約に触る。記録が無いことは集計側（可視化）が「0 件」として見せる | **要確認** |

## 分かっていないこと

- Codex が `check-direct-ddl-execution.sh` を直接呼ぶとき、hook 入力に `session_id` が入るか。入らなければ空になる（壊れはしない）
- Codex 直接呼びの `caller` は、決めてほしいこと 5 の規則では `unknown` になる見込み。実機で `CLAUDE_PROJECT_DIR` 相当の手がかりが取れると分かれば、そのとき規則に足す
- `branch` は `git rev-parse` を 1 回呼ぶ。hook の timeout は 5 秒で、普段は数十 ms。遅い環境で問題になれば外す

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 実装セット

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/lib/log-hook-decision.sh` / `scripts/lib/log-hook-decision.test.sh` | 記録関数 1 つ。RED 方向（書けなくても 0 を返し stdout に何も出さない・秘密を書かない）のテスト |
| B | 5 本の hook と各 `.test.sh` | 判定を出す直前（`jq -n` の前）に A を呼ぶ。各テストに「止めたら 1 行・通したら 0 行・書けなくても判定不変」の 3 観点を足す |
| C | `scripts/codex-skip-marker-deny.sh` / `scripts/codex-dependency-change-deny.sh` と各 `.test.sh` | 正本を呼ぶとき `AIDD_HOOK_CALLER=codex` を渡す |
| D | `scripts/lib/plugin-layout.json` | `lib/log-hook-decision.sh` を `lib/resolve-log-dir.sh` と同じ登録先に足す（`supportScripts`: aidd-core + aidd-vkumai、`codexSupportFiles`: aidd-codex-vkumai） |
| E | `docs/agents/file-index.md` / `docs/agents/actuator-inventory.md` | 索引に 1 行。棚卸し表の分類基準に「block / ask / warning-only の判定は `logs/hook-decisions.jsonl` に残る」の注記 |

A → B/C は A の後。B と C は別ファイルなので同時に進められる。D・E は最後。

## 方針

- 関数は `log_hook_decision <hook> <decision> <rule> <tool_name> <target> <hook入力JSON>`。
  中は丸ごと `( … ) 2>/dev/null || true` で包み、**呼び出し側の `set -e` の下でも抜けない**
- 記録先は `${AIDD_HOOK_DECISION_LOG_FILE:-$(resolve_log_dir)/hook-decisions.jsonl}`（テストの注入口は他 hook と同じ命名）
- `jq` が無ければ何もしない（deny 側 hook は jq 不在で既に fail-closed に止まっているので、記録だけが飛ぶ）
- `target` は呼び出し側が渡す。Bash は hook が既に `strip_prefix` で前置きを剥いだセグメントの先頭語（`awk '{print $1}'`）。
  `check-readonly-bash` は `FIRST_BASE`、Write 系は `file_path`、`apply_patch` は当たったパス
- 記録は**判定を出す直前に 1 回だけ**。hook は最初に当たった規則で `break` するので 1 呼び出し 1 行
- `check-readonly-bash` の `deny()` は関数の中で exit するので、その中で呼ぶ

## テスト観点

- 赤の確認: 5 本とも、記録先を読み取り専用ディレクトリの下にしても、変更前と出力・exit code が同じ（変更前の出力を fixture にせず、同じ入力で `AIDD_HOOK_DECISION_LOG_FILE` を有効／無効にした 2 回を比べる）
- 対: 通す入力で記録ファイルが存在しない
- 秘密: `psql "postgres://u:secret@h/db"` → 行に `secret` が無い
- Codex: ラッパー経由の行が `caller: "codex"`、直接呼びは `AIDD_HOOK_CALLER` 無し・`CLAUDE_PROJECT_DIR` 無しで `unknown`
- 既存: `bash scripts/check-log-dir-resolution.test.sh`・`build-plugin.test.sh`・5 本＋2 本の `.test.sh`・シェルテスト全件

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし。製品コード（`src/` `supabase/`）に触れない
- 新しい値: `decision` の 3 値（deny / ask / warn）、`caller` の 3 値（claude / codex / unknown）、`rule` の 9 語。本文の表と一致
- 列挙: 対象 hook 5 本、決めてほしいこと 6 件、受け入れ条件 8 件。本文と一致
- 信号の意味: hook の stdout・exit code は変えない。記録の有無で判定が変わる経路を作らない
- 限界: 記録は「hook が判定を出した」ことであって「ツールが実際に止まった」ことではない（Codex が exit 2 以外を通す等は別の話）。allow を書かないので発火率の分母はここからは出ない
