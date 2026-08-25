# 2026-08-25 repository-docs-review

公式ドキュメント（Anthropic: code.claude.com / OpenAI: developers.openai.com/codex・agents.md標準）と
リポジトリのAI設定を突き合わせるレビューセッション。AIDDフロー（Phase 1-5）は実行していない
（プロダクトコードに触れないドキュメント・設定の軽量是正のみのため）。

## フロー実行統計

AIDDフロー実行なし。調査サブエージェント2体（Anthropic公式Doc調査 / OpenAI Codex公式Doc調査）を
並列起動し、報告を実ファイル・公式ドキュメント（WebFetch）で裏取りして是正を適用した。

## Loop Observability要約
このセッション中の新規記録なし（Workflow未実行）

## 結果
- うまくいったこと:
  - 廃止機能・非推奨設定の使用はClaude側・Codex側ともゼロと確認（最新機能への追従度は高い）
  - 軽量是正5件を適用: implementerモデル表記ドリフト修正（AGENTS.md/ai-config-map.md、実体はsonnet）、
    handoff-formatスキルの一覧漏れ追加、AGENTS.mdへビルド・テストコマンド節追加（CodexはCLAUDE.mdを
    読まないためnpm test等が伝わっていなかった）、settings.jsonのsuperpowers 6.0.3固定allow 5件削除
    （個人絶対パスかつバージョン固定でsettings.local.jsonの`*`版が既に代替）、e2e-runnerの
    allowed-toolsを`Bash`無制限から`Bash(npx playwright *)`+`Bash(${CLAUDE_SKILL_DIR}/screenshot.sh *)`へ最小化
    （公式勧告: コミット済みスキルのallowed-toolsはワークスペース信頼でゲートされない）
  - サブエージェント報告の偽陽性2件（「.claude/rules/未実装」「skills用triggered/onceフィールド」）を
    公式ドキュメント直接確認で棄却できた
- 問題・気になった点:
  - AGENTS.md/ai-config-map.mdの手書きエージェント表は実体frontmatterとドリフトしやすい
    （今回のimplementer opus/sonnet食い違いが実例。1ファイル内でも矛盾していた）
  - Codex hooks実測メモ（invocation_id固定・block fail-open）に公式ドキュメントとの食い違いがあり要再実測
- 次の課題（issue起票済み、pending_issues.jsonl経由）:
  - subagent frontmatter新フィールド（skills:プリロード/permissionMode/maxTurns）の導入検討
  - .codex/config.tomlで[features] hooks=true宣言 + Codex実測メモ3件の最新CLI再検証
  - 低優先バックログ（memory:project / context:fork / Codex async hooks等）
