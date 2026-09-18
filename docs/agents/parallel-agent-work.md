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
| subagent定義 | `.claude/agents/*.md`（**正本**） | `.codex/agents/*.toml`（メタデータは生成物） |
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

### agent 定義は md を正本にし、toml のメタデータは生成する（2026-09-11）

**二重に書いていたので、そろっているつもりの欄がずれていた。** 実測すると:

- `description` が **2 本**で違う（片方にだけ「読み取り専用。」が足されていた）
- `effort` が **6 本**で違う（Claude 未指定 / Codex `medium` など）
- `proposer` は **Claude 側がグローバル**（`~/.claude/agents/`）にしか無く、
  Codex 側だけリポジトリ内にあった——**リポジトリを配っても Claude 側では動かない**状態

```bash
node scripts/lib/generate-codex-agents.mjs           # 照合（食い違いがあれば exit 1）
node scripts/lib/generate-codex-agents.mjs --write   # md を正本に toml のメタデータを書き換える
node scripts/lib/generate-codex-agents.mjs --sections # 本文のずれ（節の欠落）を並べる
```

写像は実測して決めた（12 本すべてで一貫していた）:
`sandbox_mode` は **tools に `Edit` / `Write` があれば `workspace-write`、無ければ `read-only`**。

**本文（`developer_instructions`）はまだ写していない。** Codex 側は Claude 側の 25〜40% に
圧縮されており、sweep 系では「既知の失敗パターン」「決定的な探索手順」（recall 対策そのもの）が
落ちている。**それが意図的かどうかどこにも書かれていない**ので、いま写すと振る舞いが変わる。
写さない代わりに、**節の欠落を数えて上限を張った**（`scripts/lib/codex-agent-drift-budget.json`、
実測 64 節）。増えたら落ちる。減らす（＝写す）かどうかは、
**Codex 側で recall を測ってから**決める（測る前に写すと、良くなったのか分からない）。

全本に共通して落ちている「進捗報告（issue #18）」だけは**意図的**——上の
「Codex 側 subagent は Claude 側の観測ログに書き込まない」がその理由。

### どちらのツールに、どのイベントの検知が付いているか（2026-09-11）

**片方にしか無い検知は、そのツールで作業した人だけが守られない。**
2026-09-11 に外部レビューが目視で「Codex 側には Stop hook が 1 本も無い」ことを見つけた——
同じ人が同じリポジトリを触っていても、**使うツールで守りの厚みが変わっていた**。
目視で気づく形になっていたので、機械が並べるようにした:

```bash
node scripts/lib/aidd-doctor.mjs --verbose   # イベント別に「どちらに何本あるか」を出す
```

**揃えるべきだとは言わない。** ツールごとに使えるイベントが違う（`SubagentStart` /
`InstructionsLoaded` / `Setup` は Codex に無い）。並べるところまでが機械の仕事で、
足りないものを足すかどうかは人が決める。

同じ日に、Codex 側へ品質チェックの警告（`codex-ai-check-track.sh` / `codex-ai-check-suggest.sh`）を
派生先から逆輸入した。**Claude 版と作りが違う**——Claude は transcript から実行コマンドを直接読むが、
**Codex の transcript は形式が安定しない**ので、PostToolUse で「打った瞬間のソースの姿」を残し
Stop で比べる。結果として Codex 版のほうが厳しい（打った**後**に触ればまた警告する）。

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
