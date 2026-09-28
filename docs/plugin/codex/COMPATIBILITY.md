# AIDD Codex: 対応状況

| 配布物 | Codex 公式文書 | 実機での導入・信頼・発火 |
| --- | --- | --- |
| 0.1.0 | 2026-09-26 に [portable `plugin.json` と hook 配置](https://developers.openai.com/plugins/build/plugins)を確認 | Codex CLI 0.147.0 で導入・信頼・4 本の発火を実測（evidence 2026-09-27-verify.md） |
| 0.1.1 | 同上 | 未実測（marketplace リポジトリ経由の導入を配布後に実測し更新する。RELEASE.md §7） |

ルートの `plugin.json` は Agent Plugins 1.0 の形式を使う。`hooks/hooks.json` は `extensions.com.openai.hooks` から参照する。hook 実行時の `PLUGIN_ROOT` は Codex が渡すが、スキルから起動する doctor は自身のスクリプト位置を使う。

必要な実行系は Bash、`jq`、`git`、`gh`（PR 判定には認証も必要）、`python3`。doctor は不足を行ごとに表示する。
