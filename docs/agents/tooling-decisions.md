# ツール・機能導入可否の判断記録

このファイルは [`common.md`](./common.md) の「毎セッション必須ルール」から分離した参照ドキュメントである（issue #486）。個々の公式機能・プラグインを採用するか見送るかの実機検証結果・判断理由を記録する。行動を変える指示ではなく、経緯を確認したいときに読む。[`decisions.md`](./decisions.md) が設計判断一般を記録するのに対し、ここは「外部ツール・機能を使うか使わないか」という導入可否判断に特化する。common.md側には各節への1行リンクが残っている。

## Bashサンドボックス機能は現行toolchainと非互換のため保留（issue #438）

実機検証の結果、`sandbox.enabled: true`はgh/supabase CLI（Go製）のHTTPS通信をTLS証明書検証
エラーで壊すことが確認された。本プロジェクトの開発フローはgh・supabase CLIの両方に強く依存して
おり導入できない。検証結果・原因の切り分け・再開条件は
[`decisions.md`の該当項目](./decisions.md#なぜbashサンドボックス機能issue-438を導入せず保留にしたか)を参照。

## Channels（issue #448）は今回のユースケース（夜間ジョブ通知）に不向きなため見送り

公式Channels（research preview、Telegram/Discord/iMessage連携）を夜間検査ジョブの通知先に
使う提案があったが、実機確認の結果「イベントはセッションが開いている間のみ届く」という
制約があり、Claude Codeセッションが閉じている夜間の時間帯にcron等から起動したジョブの結果を
通知するという想定用途と噛み合わないことが判明した。加えてデータ暗号化・HIPAA等の規制対応が
公式ドキュメントに未記載という懸念も残る。詳細・再開条件は
[`decisions.md`の該当項目](./decisions.md#なぜchannelsissue-448を導入せず見送ったか)を参照。

## claude-code-action（issue #447）は費用対効果の観点で見送り

GitHub Actions内でclaude-code-action（@claudeメンションでのissue/PR自動対応）を導入する
提案があったが、Anthropic API keyでの従量課金（既存のClaude Pro/Maxサブスクとは別建て）が
必須と判明した。技術的には導入可能だが、このリポジトリの運用はローカルのClaude Codeセッション
（既存サブスクの範囲内）で既にissueトリアージ・PR作成をこなせており、追加コストに見合う
明確な必要性が無いと判断した。issue #438・#448（技術的非互換・設計思想の不一致）とは異なる
「単純な費用対効果」の判断であることに注意。詳細・再開条件は
[`decisions.md`の該当項目](./decisions.md#なぜclaude-code-actionissue-447を導入せず見送ったか)を参照。

## security-guidanceプラグインでknown-failure-patterns.mdを機械検知化（issue #440）

公式プラグイン`security-guidance@claude-plugins-official`を導入し、`docs/agents/
known-failure-patterns.md`のチェックリスト（自然言語のみ、レビュー系エージェントが
「読むこと」に依存していた）の一部を機械検知化した。`.claude/settings.json`の
`enabledPlugins`にチーム共有で有効化した（per-edit層は無料でありセキュリティ検知機能を
チーム全員に一律適用すべきという判断。詳細は`decisions.md`参照）。

- `.claude/security-patterns.json`: `rls_bypass`（RLS無効化・ポリシー変更検知）・
  `bare_sql_in_data_layer`（`src/lib/supabase/**`での生SQL実行検知）・
  `possible_real_facility_name`（seed/E2E/eval-fixturesパスへの実在施設名らしき文字列の検知）・
  `security_definer_grant`（`SECURITY DEFINER`関数の検知）の4パターンを定義
- `.claude/claude-security-guidance.md`: RLS/facility境界の原則（全ポリシーが`auth.uid()`
  または`facility_id`参照、admin判定はDB role経由、機微データをINFO以上でログ出力しない等）
  を自然言語で記述
- **既知の限界**: プラグインの実際のインストール（`/plugin install
  security-guidance@claude-plugins-official`）は対話的な操作が必要で、このセッションでは
  実行できていない。`enabledPlugins`の設定のみ先行してコミットしており、実際に機能するかは
  次回以降のセッションで人間が`/plugin install`を実行してから確認する必要がある
- ターン末diffレビュー・commit時レビューはモデル呼び出しを伴いトークンコストが発生する
  （`ENABLE_STOP_REVIEW=0`・`ENABLE_COMMIT_REVIEW=0`環境変数で個別に無効化可能）。今回は
  per-edit層と合わせて3層とも有効化する判断をした（人間の確認済み）
- 詳細・スキーマの出典は
  [`decisions.md`の該当項目](./decisions.md#なぜsecurity-guidanceプラグインissue-440をチーム共有で全層有効化したか)を参照。

## blockedラベルの再開条件見直しはSessionStart hookで機械ポーリング（issue #453）

`blocked`ラベルの再開条件（例: issue #438の`decisions.md`記載事項）を誰がいつ見直すかの
仕組みが無かった問題は、cron等の常時稼働ではなく`scripts/check-blocked-issues-staleness.sh`
（SessionStart hook）による最小限のポーリングで解決した。`blocked`ラベルの付いたOPEN issueが
既定90日（`BLOCKED_ISSUE_STALE_DAYS`で変更可）以上更新されていなければ警告する
（block不可・warningのみ、`check-branch-pr-status.sh`と同じフェイクgh注入によるテストパターン）。
設計判断の詳細は
[`decisions.md`の該当項目](./decisions.md#なぜblockedラベルの再開条件見直しをcronではなくsessionstart-hookのポーリングにしたかissue-453)を参照。

## 定期実行の機械トリガー化はSessionStart hookに一本化、OS launchdは見送り（issue #443）

issue #443は当初「OS launchd等による夜間バッチジョブで、複数の人起動チェック（gap check・
baseline鮮度・fault injection訓練・eval:workflows未実行検知）をまとめて機械トリガー化する」
という提案だった。調査の結果、対象として挙げられていたチェックの大半（`check-loop-observability-gap.sh`・
`check-agent-progress-gap.sh`は単発フロー実行の前後差分が前提、`check-agent-baseline-freshness.sh`
はCI/PR diff前提、eval:workflowsは実行記録の仕組み自体が無い）が夜間バッチに転用できないと
判明し、実装可能だったのは`scripts/check-fault-injection-drill-staleness.sh`
（`docs/agents/fault-injection-drill.md`「## 次回実施予定日」の期限切れ検知）1件のみだった。

OS launchd等の常時稼働の仕組みは、無人でGitHub issue作成等の外部作用を持ちうる恒久的な
バックグラウンドサービスの新設になるため導入を見送り、`#453`と同じSessionStart hook
パターンに一本化した。設計判断の詳細は
[`decisions.md`の該当項目](./decisions.md#なぜissue-443の夜間バッチ構想をsessionstart-hookに縮小したか)を参照。

## autoMode(hard_deny)は個人設定のみ有効・設定し忘れ検知はSessionStart hookで（issue #439）

`autoMode.hard_deny`（ユーザー意図でも上書き不可の無条件ブロック）は、公式仕様上
**ユーザー個人の`~/.claude/settings.json`でしか読まれない**（プロジェクト側の
`.claude/settings.json`・`.claude/settings.local.json`はリポジトリが自身に許可ルールを
注入するのを防ぐため対象外。出典・理由は
[`decisions.md`の該当項目](./decisions.md#なぜautomodehard_denyを個人設定のみにしsessionstart-hookで設定し忘れを検知することにしたかissue-439)を参照）。
このためリポジトリにコミットして全員へ強制することはできない。

**有効化したい場合、各自の`~/.claude/settings.json`に以下を追加する（推奨設定・任意）:**

```json
{
  "autoMode": {
    "environment": "Supabase(prod)には患者・施設の実データが保存されている。supabase/migrations/配下がRLSポリシーの正本。",
    "hard_deny": [
      "患者・施設の実データをSupabase以外のドメイン（外部API・PR本文・issue本文等）へ送信しない",
      "RLS policyの無効化・変更をブロックする",
      "本番Supabaseへの直接DDL実行をブロックする"
    ]
  }
}
```

**設定し忘れ検知**: `scripts/check-automode-config.sh`（SessionStart hook）が、個人設定に
`autoMode.hard_deny`が無ければセッション開始時に警告する（block不可・warningのみ）。
「ドキュメントに書いただけでは気づかれない」という同型の問題（issue #423の発端になった
loop-observability記録漏れ等）を繰り返さないための対応。ただし内容の妥当性までは検証せず、
`hard_deny`に1件以上のルールがあるかという存在チェックに留まる。
