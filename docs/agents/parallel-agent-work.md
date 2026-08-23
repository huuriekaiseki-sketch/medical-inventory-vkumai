# Claude Code / Codex 並行作業ルール（このリポジトリでの運用）

同じGitHubリポジトリをClaude CodeとCodexの両方で使う際の、競合（バッティング）防止の運用手順。
設計原則の全体像とリポジトリ非依存の移植手順は
[`claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md) を参照。

## 絶対ルール: 同一worktreeでの同時作業禁止

Claude CodeとCodexを**同じ物理worktreeで同時に動かさない**。
編集・ステージング・migration番号・開発サーバーのポート・`.next/`キャッシュ等が競合する。

- Claude Code用worktree/ブランチと、Codex用worktree/`codex/*`ブランチを分離する
- PRも別々に作る（1つのPRに両ツールのコミットを混ぜない）
- ブランチ命名規約: Codexの作業ブランチは `codex/` プレフィックスを付ける。
  Claude Codeのworktree自動作成ブランチは `claude/` プレフィックスが付く
- **検知**: 命名規約と起動ツールの取り違え（Claude Codeが`codex/*`を開く・逆も）は
  SessionStart hook（`scripts/check-branch-tool-ownership.sh`、両ツールの設定に登録済み）が
  警告する（warning-only）。プロセスレベルの同時実行そのものの機械検知は無い
  （[`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md)参照）

## 作業開始前の確認（両ツール共通）

1. `git branch --show-current` — 今いるブランチが自分のツール用か確認する
2. `gh pr list --head <branch>` — 別issue用の未マージPRの対象ブランチでないか確認する
3. `git worktree list` — 相手ツールが使用中のworktreeを流用していないか確認する
4. 新しいブランチは `git fetch origin main` してから `origin/main` 起点で切る
   （worktree作成は `scripts/create-worktree.sh` を使う。
   詳細は [`common.md`](./common.md)「ブランチ運用ルール」）

## 状態・設定の分離（触ってはいけない場所）

| | Claude Code | Codex |
|---|---|---|
| hook設定 | `.claude/settings.json` | `.codex/hooks.json` |
| subagent定義 | `.claude/agents/*.md` | `.codex/agents/*.toml` |
| 状態ファイル | `.claude/` 配下 | `.codex/` 配下 |

- 一方のツールが他方の設定ファイル・状態ファイルを参照・編集しない
  （分離は `scripts/codex-config-separation.test.sh` が機械検証する）
- **例外＝共有してよいもの**: `scripts/` 配下のツール非依存な安全ガード
  （`check-direct-ddl-execution.sh` 等）と読み取り専用の共有ドキュメント（`docs/`）。
  判断基準は「2つのコピーが食い違ったとき、それは仕様か、バグか」——
  必ずバグになるもの（危険操作の判定）だけを共有する
- Codex側subagentはClaude Code側の観測ログ（`logs/` 配下・
  `scripts/log-agent-progress.sh` 等）に**書き込まない**。Codexの記録が混ざると
  Claude側のgap check集計（期待件数 vs 実測件数の突合）が狂う

## push前検証ゲート（hook変更時）

hook・ガードスクリプトを変更した場合、push前に以下を両方満たすこと
（「旧hookで検証成功→新hookをpush」の抜け穴防止）:

1. 検証前にworktreeがclean（未コミット変更なし）であることを確認する
2. 実機検証に使ったclone/worktreeのHEAD SHAと、pushする対象のHEAD SHAが
   一致することを確認する（`git rev-parse HEAD` を両側で突合）

Codex hookの実機検証手順は
[`claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md)の
「実機検証手順」を参照（Terminalから`codex` CLI起動が必須。GUIのChatGPT.appは
環境変数が渡らないため不可）。
