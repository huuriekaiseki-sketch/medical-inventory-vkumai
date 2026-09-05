# 既知の制約（7 項目の 7 の後半）

## 層の切り方（v1.0）

- Workflow 5 本と sweep 4 軸・implementer 系 3 体は `aidd-vkumai` にある。共通側だけ入れても AIDD の
  フロー（調査→仕様→実装）は動かない。Next.js + Supabase 以外のスタックで使うには、`aidd-vkumai` を
  ひな形に自分のアダプターを作る（v1.x で Workflow を共通側へ移す計画。`docs/specs/plugin-v1/SPEC.md`）
- `check-readonly-bash.sh`（読み取り専用ロールの Bash deny）はアダプター側。npm / npx の許可リストが
  スタック固有のため。共通側にするには許可リストの設定化が要る

## Claude Code の仕様による制約

- `.claude/rules/`（パス限定ルール）と CLAUDE.md は同梱できない。導入先が持つ（`templates/consumer/`）
- Workflow は導入先のファイルを読めない。固有語彙は `args.riskConfig` で渡す（wrapper Workflow の役目）
- `InstructionsLoaded` の出力は無視される。常時ロード量の上限判定は SessionStart の
  `check-claude-md-size.sh` が担う
- プラグイン同梱 subagent の frontmatter `hooks` / `permissionMode` / `mcpServers` は無視される

## 運用上の制約

- Codex には配布できない（プラグイン機構が無い）。`.codex/hooks.json` と `.codex/agents/*.toml` は
  導入先へ手コピー
- 中心リポジトリと同じ hook を settings.json とプラグインの両方で入れると二重に発火する。中心リポジトリ
  自身では生成物を読まない
- hook 33 本のうち 18 本が node / python3 / npx のいずれかを呼ぶ。無い環境では fail-open で沈黙する
  （警告が出ないだけで、止まりはしない）
- 個人環境のスクリプト（`~/write_aidd_stats.sh`・`~/.claude/pending_issues.jsonl`）は同梱しない。
  それらに依存する Stop hook（AIDD stats の記録漏れ検知）は導入先で該当スクリプトが無ければ沈黙する
- `gate-effectiveness-monthly-check.sh` 等の TS 補助スクリプトは node の `--experimental-strip-types`
  で動く。node 22 未満では失敗し、fail-open で沈黙する
- 共通 fixture による回帰テスト（7 項目の 5）は v1.0 では中心リポジトリの `scripts/*.test.sh` と vitest
  が担い、生成物に対しては `scripts/build-plugin.test.sh` の構造検査（決定性・名前空間・同梱閉包・禁止語）
  のみ。生成物を直接テストする仕組みは別リポジトリ化（配布形態 (a)）のときに作る

## 未検証

- `dependencies` の解決順（`--plugin-dir` 2 つ同時指定では検証不能。marketplace 経由で確認する）
- fault-injection 4 シナリオのプラグイン経由での実測（受け入れ条件 3 件目）
- 共通 hook 全件の実走ドリル（プラグイン経由）
