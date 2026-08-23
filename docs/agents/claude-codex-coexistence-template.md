# Claude Code / Codex 共存設計 標準テンプレート

同じGitHubリポジトリをClaude CodeとCodexの両方で使うための、**リポジトリ非依存**の設計原則と
移植手順。riff-gear（`codex/aidd-native-port`）・cardiosearch（issue #52）での実機検証結果に
基づく。新しいリポジトリで併用を始めるときは、このテンプレートの「移植チェックリスト」を
上から順に適用する。

このリポジトリ（vkumai）での具体的な運用は [`parallel-agent-work.md`](./parallel-agent-work.md) を参照。

## 前提となる実機検証済みの事実

設計判断の根拠となる、机上では分からなかった実測結果:

1. **CodexのPreToolUseは `permissionDecision: "ask"` 未対応**。denyは通る。
   askのまま登録すると確認プロンプトが出ずに素通りする
2. **CodexのStop系hookに「拒否」という手段は存在しない**（cardiosearch 2026-08-13実測）。
   受理されるのはexit 0のみ。`decision:"block"`のstdout出力もexit 2も
   `invalid stop hook JSON output` となり、**再試行ストーム（SubagentStop多重発火）を誘発**する
3. **GUI（ChatGPT.app）経由では環境変数がhookプロセスへ渡らない**。
   実機検証はTerminalから`codex` CLIを起動して行う
4. **linked worktreeではCodexのproject hookが読み込まれないことがある**（riff-gear実機で発生）。
   独立cloneで検証するか、`codex`にhookを明示的にレビュー・信頼させる
5. **hookはfail-open**。共有スクリプトを片側専用と誤認して移動・改変しても、テストもCIも
   緑のまま、もう片方の安全機構だけが無言で死ぬ（cardiosearchで`$CLAUDE_PROJECT_DIR`依存が
   原因でCodex hookが壊れた実例）

## 設計原則（9項目）

### 1. 設定ファイルの完全分離
- Claude用: `.claude/settings.json`、Codex用: `.codex/hooks.json` + `.codex/agents/*.toml`
- 一方が他方の設定ファイルを参照・実行してはいけない（双方向とも）

### 2. 共有スクリプトはツール非依存にする
- `scripts/` 配下の共有ロジックに `$CLAUDE_PROJECT_DIR` 等のツール専用環境変数を書かない
- パス解決は `$(git rev-parse --show-toplevel)`（hook設定側）・
  `$(dirname "${BASH_SOURCE[0]}")` 起点（スクリプト内）等、gitとファイル位置ベースに統一する
- **共有/分離の判断基準**: 「2つのコピーが食い違ったとき、それは仕様か、バグか」。
  食い違いが説明できるもの（hook登録方法・subagent追跡・プロンプト最適化）は分離、
  食い違ったら必ずバグのもの（危険操作の判定）は1箇所に置いて両側から参照する

### 3. Codexの出力契約の違いを前提にする
- Claude用の`ask`ガードをそのまま移植しない。Codex側では`deny`へ読み替える
  （安全側でブロックし、人間の手動実行を促す）。読み替えは判定ロジックを複製せず、
  共有正本を呼んで出力だけ変換するラッパーで行う（例: `scripts/codex-skip-marker-deny.sh`）
- Stop系hookは「記録のみ・exit 0・stdout空」で設計する（拒否手段は存在しない）

### 4. ガードの文字列一致は迂回経路を塞ぐ
危険コマンド検知は、コマンド名の単純一致だけでなく以下も検知する:
- 絶対パス実行: `/usr/local/bin/<cmd> ...`
- 相対パス実行: `./node_modules/.bin/<cmd> ...`
- パイプ・`;`・`&&`・コマンド置換 `$( )` を挟んだ実行
既存のdeny系hook全部について同様の迂回経路が無いか横展開でチェックし、テストで固定する

### 5. 実機検証を必須工程にする
自動テスト全PASSでもhookの発火契約はテストできない。新規・変更したCodex hookは
「実機検証手順」（後述）を必ず実施する。**実機検証完了前にpushしない**

### 6. Codex subagentの権限を明示指定する
- レビュー・調査系の読み取り専用subagentには `sandbox_mode = "read-only"` をTOMLで明示する
- 未指定だと親セッションの権限（workspace-write等）を継承し書き込み可能になる
- 書き込みを担うsubagentも `sandbox_mode = "workspace-write"` を明示し、
  「全tomlがsandbox_modeを明示」をテストで機械強制する（例: `scripts/codex-agents-sandbox.test.sh`）

### 7. 状態ファイルを完全分離する
- 状態保存パスはCodex用 `.codex/...`、Claude用 `.claude/...` に分離する
- CodexのStop hook相当はClaude Code形式のtranscriptを解析しない
  （Codexのtranscript形式は安定インターフェースとして保証されていない）
- 観測ログ（進捗記録等）も分離する。片方の集計・gap checkが相手の記録で狂うため

### 8. push前検証ゲートの整合性を保証する
「独立cloneで検証してからpush」の運用では以下を両方満たす:
- 検証前にworktreeがclean（未コミット変更なし）であることを確認する
- 検証に使ったcloneのHEAD SHAとpush対象のHEAD SHAの一致を確認する
（さもないと「旧hookで検証成功→新hookをpush」の抜け穴が生まれる）

### 9. 同一worktreeでの同時作業を禁止する
- Claude Code用worktree/ブランチとCodex用worktree/`codex/*`ブランチを分離し、PRも個別に作る
- ブランチ命名規約（`codex/*` / `claude/*`）との取り違えはSessionStart hook
  （`scripts/check-branch-tool-ownership.sh`、両ツールに登録・warning-only）で部分検知する

### 10. 上記をAGENTS.md / CLAUDE.mdに明文化する
- Codexが読む`AGENTS.md`とClaude Codeが読む`CLAUDE.md`の両方に「同一worktreeで並行作業しない」
  「作業開始前にGit状態・既存PR・worktreeを確認する」を明記し、詳細手順は別ドキュメント
  （`docs/agents/parallel-agent-work.md`）に切り出してリンクする

## 実機検証手順（原則5の具体化）

自動テストで検証できるのは「スクリプト単体の入出力」まで。**hookが本当に発火するか**は
以下でのみ検証できる:

1. **Terminalから`codex` CLIを起動する**（GUIのChatGPT.appは環境変数が渡らず不可）
2. `/hooks` でSource・Active・Reviewを確認する（project hookが読み込まれているか）
3. 対象コマンドを実際にトリガーし、本当にブロック/記録されるか目視確認する
4. 実インフラに繋がるコマンド（vercel等）の検証は、PATHを差し替えた偽コマンドスクリプトで
   行い、本物の認証情報・環境には接続しない
5. linked worktreeではproject hookが読まれないことがあるため、独立cloneで検証するか、
   `codex`にhookを明示的にレビュー・信頼させる
6. 検証したcloneのHEAD SHAとpush対象のHEAD SHAが一致することを確認してからpushする（原則8）

## 移植チェックリスト（新しいリポジトリへの適用手順）

1. [ ] 現状把握: `.claude/settings.json`のhook一覧・`.codex/`の有無・
       `grep -rl CLAUDE_PROJECT_DIR scripts/` でツール専用変数依存を洗う
2. [ ] 共有すべき安全ガード（deny系）を特定する（判断基準は原則2）。
       ガード本体からツール専用変数を除去する
3. [ ] deny系ガードの迂回経路（絶対パス・相対パス・パイプ・コマンド置換）をテストで固定する（原則4）
4. [ ] `.codex/hooks.json` を作成: 共有deny系ガードを登録、ask型はdeny変換ラッパー経由、
       transcript依存スクリプトは登録しない、パス解決は`$(git rev-parse --show-toplevel)`
5. [ ] `.codex/agents/*.toml` を作成し、全tomlに`sandbox_mode`を明示する（原則6）
6. [ ] 分離を機械検証するテストを移植する（`codex-config-separation.test.sh`・
       `codex-agents-sandbox.test.sh` 相当。両側から参照される共有ファイルの存在・
       実行可能性・非参照の固定）
7. [ ] `check-branch-tool-ownership.sh` 相当を両ツールのSessionStartに登録する（原則9）
8. [ ] `AGENTS.md` / `CLAUDE.md` に並行作業禁止を明記し、詳細手順ドキュメントへリンクする（原則10）
9. [ ] 実機検証（上記手順）を実施してからpushする（原則5・8）

## 既知の限界

- ブランチ所有権チェックは命名規約ベースの部分検知。プロセスレベルの同時実行検知は無い
- Codex hookの発火契約（SessionStartのJSON出力がcontext注入されるか等）はバージョンアップで
  変わりうる。ツール本体更新時は再検証する（このリポジトリでは
  [`load-bearing-workarounds.md`](./load-bearing-workarounds.md)の棚卸し対象）
- 自動テストはスクリプト単体の入出力のみを検証する。hookが「登録され・発火する」ことの
  保証は実機検証（原則5）にのみ依存する
