# AIDD Codex vkumai: 対応状況

| 配布物 | 前提スタック | 実機での導入・信頼・発火 |
| --- | --- | --- |
| 0.1.2 | Next.js + Supabase + npm（vkumai と同じ）。Supabase CLI は Homebrew 版（`npx supabase` は deny） | 生成のみ（marketplace 未掲載） |
| 0.1.3 | 同上 | Codex CLI 0.147.0 で Git marketplace から導入。未信頼では hook が動かず（対照）。`/hooks` で対象4本を個別に信頼後、bypass 無しの PreToolUse DDL deny、PostToolUse の記録、対話 CLI 上の Stop 警告を確認。remove → add 後も4本の信頼は維持（[初回](evidence/2026-09-28-first-install-verify.md)、[信頼後](evidence/2026-09-28-trusted-fire-verify.md)） |
| 0.1.4 | 同上 | Codex CLI 0.147.0 で `marketplace upgrade` だけで 0.1.3 → 0.1.4 に入れ替わり、`trusted_hash` 4 件は維持。配布した版で、`apply_patch` による `package.json` の新規作成・`PGPASSWORD=… psql -c`・`sudo -u postgres psql -c`・`CI=1 npm install left-pad` が止まること、`psql --version` は止まらないことを実測（`docs/plugin/codex/evidence/2026-09-29-release-0.1.4-verify.md`）。**この版から `psql --version` は止まらない**ので、DDL の deny の確認には `psql -c "select 1"` などを使う。`package-lock.json` の削除・複数ファイルのパッチ・`bash -c "psql …"`・`(psql …)`・`env psql`・`npm --prefix web install left-pad` が止まること、`command -v psql` と `CI=1 npm test` は止まらないことも実測。記録の置き場に書けないときの hook は、非対話モードでは確かめられなかった（直す前の版でも失敗が出力・保存記録に現れない）。判定本体が欠けたときの fail-closed は、依存変更側では実機未実測 |

manifest は `aidd-codex` と同じ `.codex-plugin/plugin.json` 形式（ルート `plugin.json` は出さない。根拠は `docs/plugin/codex/evidence/2026-09-27-verify.md` の実験 C'）。hook 実行時の `PLUGIN_ROOT` は Codex が渡す。

必要な実行系は Bash、`jq`（4 本すべてが使う。無いと deny 系は exit 2 で fail-closed、警告系は黙って終了）、`git`、`shasum`。`npm` 系コマンドと `supabase` CLI の有無は判定に影響しない（コマンド文字列だけを見る）。
