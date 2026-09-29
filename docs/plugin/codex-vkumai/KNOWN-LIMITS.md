# AIDD Codex vkumai: 既知の制約

- **スタック固有。** Supabase を使わない導入先では `check-direct-ddl-execution.sh` は何も止めず、npm を使わない導入先では `codex-dependency-change-deny.sh` は何も止めない。`codex-ai-check-*` は `.ts` / `.tsx` / `.sql` を変えると `npm run ai:check` 系を打ったかを見るので、npm を使わない導入先では**ソースを触るたびに毎回警告する**。そのスタックでなければ入れない（共通の `aidd-codex` だけを入れる）。
- コマンド名・拡張子・状態ファイルの場所は固定（`codex-ai-check-track.sh` の `CHECK_PATTERN`、`.ts/.tsx/.sql`、`.codex/.ai-check-suggest-state`）。導入先設定から読む形にはなっていない（仕様書 §6「vkumai 固有 Codex hook の共通化」は導入先が 2 つ以上になってから）。
- `codex-ai-check-track.sh` は導入先リポジトリの `.codex/.ai-check-suggest-state/` にセッションごとのハッシュを書く。**導入先の `.gitignore` に `/.codex/.ai-check-suggest-state/` を足す**（vkumai は足してある。プラグインは導入先の `.gitignore` を書き換えない）。7 日より古いものは自動で消す。
- deny 系 2 本（DDL・依存変更）は Claude 側の ask を Codex では一律 deny に読み替える（Codex の PreToolUse は `ask` 未対応）。本当に必要な操作は人が手で実行する。
- **0.1.3 までは、Codex のファイル編集（`apply_patch`）で `package.json` / `package-lock.json` を書き換えても止まらない。** 止まるのはシェル経由（`npm install <名前>` など）だけ。判定本体が Claude の形（`Write` / `Edit` + `file_path`）しか知らなかったため。次の版で `apply_patch` のヘッダ行（`*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`）を読むようにした。Codex CLI 0.147.0 の実機で、`apply_patch` による `package.json` の新規作成が止まることを実測した（2026-09-29。中心リポジトリの `docs/plugin/codex/evidence/2026-09-29-apply-patch-verify.md`）。実機で測ったのは `Add File` だけで、残り 3 種はスクリプト単体のテストのみ。desktop app と CLI 0.158 系は未検証。
- 上の直しが入ると、**Codex は `package.json` を一切編集できない**（`scripts` 欄だけの変更でも止まる。Claude 側は全件で確認を出しており、Codex は確認を出せないため）。1 つのパッチに複数のファイルが入っていて 1 つでも該当すれば、パッチ全体が止まる。ヘッダが 1 行も取れない `apply_patch` は止めない。パッチの本文は見ない。
- DDL の deny（`check-direct-ddl-execution.sh`）はシェルと MCP の `execute_sql` だけを見る。ファイル編集は対象外（migration ファイルを書くのは正規の手順）。
- `codex-dependency-change-deny.sh` は `check-dependency-change.sh` を `SCRIPT_DIR` 相対で呼ぶ。両方を同じ `scripts/` に同梱しているので書き換え無しで動くが、片方だけを別の場所へ動かすと壊れる。
- hook は Codex で利用者が信頼するまで実行されない（`aidd-codex` と同じ）。導入後に `/hooks` で 4 本を確認して信頼する。`aidd-codex` の doctor はこのプラグインの hook を診断しない。
- 中心リポジトリ vkumai 自身に入れると project hook（`.codex/hooks.json`）と二重発火する。vkumai では project hook を正とする。
- `check-direct-ddl-execution.test.sh` と `codex-ai-check.test.sh` は中心リポジトリの `.claude/settings.json` / `.codex/hooks.json` / `.gitignore` を名指しで見るため同梱しない。同梱する検査は `check-dependency-change.test.sh` のみ。
