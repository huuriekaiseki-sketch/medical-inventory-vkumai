# AIDD Codex vkumai: 対応状況

| 配布物 | 前提スタック | 実機での導入・信頼・発火 |
| --- | --- | --- |
| 0.1.2 | Next.js + Supabase + npm（vkumai と同じ）。Supabase CLI は Homebrew 版（`npx supabase` は deny） | 未実測（生成のみ。導入・4 本の信頼・発火は配布後に検証用リポジトリで実測し更新する） |

manifest は `aidd-codex` と同じ `.codex-plugin/plugin.json` 形式（ルート `plugin.json` は出さない。根拠は `docs/plugin/codex/evidence/2026-09-27-verify.md` の実験 C'）。hook 実行時の `PLUGIN_ROOT` は Codex が渡す。

必要な実行系は Bash、`jq`（4 本すべてが使う。無いと deny 系は exit 2 で fail-closed、警告系は黙って終了）、`git`、`shasum`。`npm` 系コマンドと `supabase` CLI の有無は判定に影響しない（コマンド文字列だけを見る）。
