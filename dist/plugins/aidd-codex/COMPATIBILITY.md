# AIDD Codex: 対応状況

| 配布物 | Codex 公式文書 | 実機での導入・信頼・発火 |
| --- | --- | --- |
| 0.1.0 | 2026-09-26 に [portable `plugin.json` と hook 配置](https://developers.openai.com/plugins/build/plugins)を確認 | Codex CLI 0.147.0 で導入・信頼・4 本の発火を実測（evidence 2026-09-27-verify.md） |
| 0.1.1 | 同上 | Codex CLI 0.147.0 で Git marketplace から導入・4 本の信頼・(c) の発火を実測（evidence 2026-09-28-marketplace-verify.md） |
| 0.1.2 | 同上 | Codex CLI 0.147.0 で 0.1.1 からの更新を実測。`marketplace upgrade` だけで入れ替わり、`trusted_hash` 4 件は維持、再信頼なしに SessionStart 2 本が発火（evidence 2026-09-28-version-update-verify.md） |
| 0.1.3 | 同上 | Codex CLI 0.147.0 で `marketplace upgrade` だけで 0.1.2 → 0.1.3 に入れ替わり、`trusted_hash` 4 件は維持（0.1.2 と同じ挙動の再現） |
| 0.1.4 | 2026-09-29 に [hook の入力の形](https://learn.chatgpt.com/docs/hooks)を確認（ファイル編集は `tool_name: "apply_patch"`、matcher の `Edit` / `Write` はそのエイリアス） | Codex CLI 0.147.0 で `marketplace upgrade` だけで 0.1.3 → 0.1.4 に入れ替わり、`trusted_hash` 4 件は維持（**スクリプトの中身が変わる版でも再信頼は不要**、の初めての実測）。配布した版で、`apply_patch` による skip マーカーの新規作成・更新・移動が止まること、skip マーカーを `cat` で読むのは止まらないこと、SessionStart の警告 2 本が案内なしの文言で出ることを実測（evidence 2026-09-29-release-0.1.4-verify.md）。判定本体を一時的に退避すると、`echo hello` と `apply_patch` がどちらも止まり、理由に欠けているものと直し方が出ることも実測（Codex は hook の exit 2 を止める扱いにする）。doctor の `部品` 行は実機では未実測 |
| 0.1.5 | 2026-09-30 に [hook の読み込みの条件](https://learn.chatgpt.com/docs/hooks)を確認（リポジトリの hook は、リポジトリの `.codex/` の層が信頼されているときだけ読み込まれる） | 未実測（配ってから測る）。このプラグインの hook とスクリプトは 0.1.4 と同じ |

ルートの `plugin.json` は Agent Plugins 1.0 の形式を使う。`hooks/hooks.json` は `extensions.com.openai.hooks` から参照する。hook 実行時の `PLUGIN_ROOT` は Codex が渡すが、スキルから起動する doctor は自身のスクリプト位置を使う。

必要な実行系は Bash、`jq`、`git`、`gh`（PR 判定には認証も必要）、`python3`。doctor は不足を行ごとに表示する。
