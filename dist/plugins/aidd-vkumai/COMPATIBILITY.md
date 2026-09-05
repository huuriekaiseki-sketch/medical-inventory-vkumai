# 対応バージョン（7 項目の 1）

正本は中心リポジトリの `docs/agents/upstream-docs-review.md`「最後に確認した版」。本ファイルはプラグインの
版ごとに「どの版で実測したか」「どの版の docs を読んで設計したか」を固定する。差分が出たら docs 差分の
定期確認（月 1）で更新し、破壊的な差があれば `BREAKING.md` に書く。

| プラグイン版 | Claude Code（実測） | Claude Code（docs 確認） | Codex CLI | 備考 |
|---|---|---|---|---|
| 0.1.0 | 2.1.258 | 2.1.261 | 対象外（0.153.4 で docs 確認のみ） | 2026-09-05。名前空間・`${CLAUDE_PLUGIN_ROOT}`・プラグイン間呼び出し・InstructionsLoaded の出力無視を実測 |

## 前提にしている Claude Code の挙動（変わると壊れる）

- agent / workflow はプラグイン名で修飾される（`plugin:name`）。非修飾は失敗する
- hook の `command` で `${CLAUDE_PLUGIN_ROOT}` が展開され、hook の cwd と `CLAUDE_PROJECT_DIR` は導入先
- プラグインの `bin/` が Bash ツールの PATH に足される（agent 本文の裸のスクリプト名はこれに依存）
- プラグイン同梱の subagent では frontmatter の `hooks` / `permissionMode` / `mcpServers` が無視される
  （ロール別ガードは hooks.json の PreToolUse + `agent_type`）
- プラグインは `.claude/rules/` と CLAUDE.md を同梱できない（導入先が持つ）
- `InstructionsLoaded` の hook 出力は無視される（記録専用）
- hook の stdin JSON の形（`session_id` / `transcript_path` / `cwd` / `agent_type` 等）。transcript の
  1 行目が `bridge-session` のことがある（Remote Control）

## 導入先の実行環境

- bash 3.2 以上（macOS 標準で可）、jq、git、gh（PR / issue 系 hook）
- node 22 以上（`--experimental-strip-types` で TS 補助スクリプトを直接実行）
- python3（パスの正規化に使う hook が 1 本）
