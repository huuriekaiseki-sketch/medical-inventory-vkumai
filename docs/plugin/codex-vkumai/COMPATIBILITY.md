# AIDD Codex vkumai: 対応状況

| 配布物 | 前提スタック | 実機での導入・信頼・発火 |
| --- | --- | --- |
| 0.1.2 | Next.js + Supabase + npm（vkumai と同じ）。Supabase CLI は Homebrew 版（`npx supabase` は deny） | 生成のみ（marketplace 未掲載） |
| 0.1.3 | 同上 | Codex CLI 0.147.0 で Git marketplace から導入。未信頼では hook が動かず（対照）。`/hooks` で対象4本を個別に信頼後、bypass 無しの PreToolUse DDL deny、PostToolUse の記録、対話 CLI 上の Stop 警告を確認。remove → add 後も4本の信頼は維持（[初回](evidence/2026-09-28-first-install-verify.md)、[信頼後](evidence/2026-09-28-trusted-fire-verify.md)） |
| 0.1.4 | 同上 | Codex CLI 0.147.0 で `marketplace upgrade` だけで 0.1.3 → 0.1.4 に入れ替わり、`trusted_hash` 4 件は維持。配布した版で、`apply_patch` による `package.json` の新規作成・`PGPASSWORD=… psql -c`・`sudo -u postgres psql -c`・`CI=1 npm install left-pad` が止まること、`psql --version` は止まらないことを実測（`docs/plugin/codex/evidence/2026-09-29-release-0.1.4-verify.md`）。**この版から `psql --version` は止まらない**ので、DDL の deny の確認には `psql -c "select 1"` などを使う。`package-lock.json` の削除・複数ファイルのパッチ・`bash -c "psql …"`・`(psql …)`・`env psql`・`npm --prefix web install left-pad` が止まること、`command -v psql` と `CI=1 npm test` は止まらないことも実測。記録の置き場に書けないときの hook は、非対話モードでは確かめられなかった（直す前の版でも失敗が出力・保存記録に現れない）。判定本体が欠けたときの fail-closed は、依存変更側では実機未実測 |

| 0.1.5 | 同上。入口が動かす点検は、加えて `python3` と `node` を使う | Codex CLI 0.147.0 で `marketplace upgrade` だけで 0.1.4 → 0.1.5 に入れ替わり、既存の `trusted_hash` は維持（**hook を足す版でも、既存の hook の再信頼は不要**、の初めての実測）。`/hooks` で新しい入口 1 本だけを信頼した後、信頼済みの親フォルダの下の作業場所（リポジトリの hook が読み込まれない場所）で、入口が発火し、3 件の知らせがセッションの記録に入った。知らせは対話画面には出ない。**更新の直後の 1 回目は、合計 5 秒の上限に達し、点検 1 本が打ち切られた。2 回目は打ち切られなかった**（[実証記録](evidence/2026-09-30-release-0.1.5-verify.md)） |

manifest は `aidd-codex` と同じ `.codex-plugin/plugin.json` 形式（ルート `plugin.json` は出さない。根拠は `docs/plugin/codex/evidence/2026-09-27-verify.md` の実験 C'）。hook 実行時の `PLUGIN_ROOT` は Codex が渡す。

必要な実行系は Bash、`jq`（5 本すべてが使う。無いと deny 系は exit 2 で fail-closed、警告系は黙って終了）、`git`、`shasum`。0.1.5 の入口が動かす点検は、加えて `python3`（期限と鮮度の判定）と `node`（hook の生存診断）を使う。`gh` は、あれば長く止まった課題の点検に使う。`npm` 系コマンドと `supabase` CLI の有無は判定に影響しない（コマンド文字列だけを見る）。
