# 対応バージョン（7 項目の 1）

正本は中心リポジトリの `docs/agents/upstream-docs-review.md`「最後に確認した版」。本ファイルはプラグインの
版ごとに「どの版で実測したか」「どの版の docs を読んで設計したか」を固定する。差分が出たら docs 差分の
定期確認（月 1）で更新し、破壊的な差があれば `BREAKING.md` に書く。

| プラグイン版 | Claude Code（実測） | Claude Code（docs 確認） | Codex CLI | 備考 |
|---|---|---|---|---|
| 0.1.0 | 2.1.258 | 2.1.261 | 対象外（0.153.4 で docs 確認のみ） | 2026-09-05。名前空間・`${CLAUDE_PLUGIN_ROOT}`・プラグイン間呼び出し・InstructionsLoaded の出力無視を実測 |
| 0.1.1 | 2.1.270（`claude plugin update` で 0.1.0 → 0.1.1 を実測。依存側は自動で上がらず個別 update） | 2.1.261 | `aidd-codex` 側は codex/COMPATIBILITY.md | 2026-09-28。中身は 0.1.0 と同じ。版上げ配布の手順（RELEASE.md）の初回実施 |
| 0.1.2 | 2.1.270（2 本の `claude plugin update` で 0.1.1 → 0.1.2 を実測） | 2.1.261 | `aidd-codex` 側は codex/COMPATIBILITY.md | 2026-09-28。差は文書のみ。版を変えた更新の実測用 |
| 0.1.3 | 2.1.270（2 本の `claude plugin update` で 0.1.2 → 0.1.3 を実測） | 2.1.261 | Codex 側は codex/ と codex-vkumai/ の COMPATIBILITY.md | 2026-09-28。差は文書のみ。`aidd-codex-vkumai` の marketplace 初掲載 |
| 0.1.4 | 2.1.270（2 本の `claude plugin update` で 0.1.3 → 0.1.4 を実測）。**版が上がることだけを確認。導入先での hook の発火は未実測**（導入先ではプラグインが disabled）。中心リポジトリでは同じスクリプトが project hook として動いている | 2.1.261 | Codex 側は codex/ と codex-vkumai/ の COMPATIBILITY.md | 2026-09-29。Codex の hook を Claude Code と同じ仕様に揃える 6 件。初めてスクリプトの中身が変わる版 |

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
