# このリポジトリの AI エージェント設定ガイド

医療在庫管理アプリ (medical-inventory-vkumai) における Claude Code / Codex のエージェント・スキル設定。
**詳細は [`docs/ai-config-map.md`](docs/ai-config-map.md) を参照。**

## Claude Code / Codex 並行作業ルール（必読）

- **同一worktreeでClaude CodeとCodexを同時に動かさない。** Claude Code用worktree/ブランチと
  Codex用worktree/`codex/*`ブランチを分離し、PRも個別に作る
- **作業開始前にGit状態・既存PR・worktreeを確認する**（`git branch --show-current` →
  `gh pr list --head <branch>` → `git worktree list`）
- ブランチ取り違え（Codexが`claude/*`を開く等）はSessionStart hookが警告する
- 詳細手順: [`docs/agents/parallel-agent-work.md`](docs/agents/parallel-agent-work.md) /
  設計原則: [`docs/agents/claude-codex-coexistence-template.md`](docs/agents/claude-codex-coexistence-template.md)

## ビルド・テストコマンド

パッケージマネージャは npm（`package-lock.json`）。

| コマンド | 用途 |
|---|---|
| `npm run dev` | 開発サーバ起動（Next.js） |
| `npm test` | ユニットテスト（vitest run） |
| `npm run lint` | Lint（`eslint --max-warnings=0`） |
| `npm run typecheck` | 型チェック（`tsc --noEmit`） |
| `npm run test:e2e` | E2Eテスト（Playwright。テスト専用Supabase接続が前提。下記「テスト環境・データ衛生ルール」参照） |
| `npm run ai:check` | typecheck→lint→test→test:e2e の一括実行。作業完了前に実行する |

## Codex 用設定（`.codex/`）

| ファイル | 目的 |
|---|---|
| `.codex/hooks.json` | Codex用hook設定（Claude用`.claude/settings.json`とは完全分離。相互参照禁止） |
| `.codex/agents/*.toml` | Codex用subagent定義。**全tomlが`sandbox_mode`を明示する**（読み取り専用ロールは`read-only`、書き込みロールは`workspace-write`。`scripts/codex-agents-sandbox.test.sh`が機械検証） |

- CodexのPreToolUseは`permissionDecision: "ask"`未対応。ask型ガードは
  `scripts/codex-skip-marker-deny.sh`（deny変換ラッパー）経由で登録する
- Codex側subagentはClaude Code側の観測ログ（`logs/`配下・`scripts/log-agent-progress.sh`）に
  書き込まない（Claude側gap check集計が狂うため）
- Codex hookを変更したら実機検証（Terminalから`codex` CLI起動・`/hooks`確認・実発火確認）を
  完了してからpushする（手順は上記テンプレートの「実機検証手順」）

## 開発フロー概要

このプロジェクトは **Parallel Subagent Framework**（5フェーズ）を採用している。
詳細フロー定義は `CLAUDE.md` を参照。

```
Phase 1 調査(並列) → Phase 2 仕様書 → [停止① 人間レビュー]
→ Phase 3 実装(TDD・並列) → Phase 4 統合ゲート
→ Phase 5 検証(並列) → [停止② /structured-review]
```

## プロジェクト固有エージェント（`.claude/agents/`）

| エージェント | モデル | 役割 | Phase |
|---|---|---|---|
| `sweep-ui` | haiku | src/app/・src/components/ を調査。コンポーネント・props・stateのバグ・型エラーを報告 | Phase 1 |
| `sweep-data` | haiku | src/lib/supabase/ とAPIルートを調査。型エラー・セキュリティ問題・設計違反を報告 | Phase 1 |
| `sweep-db` | haiku | Supabaseスキーマ・マイグレーション・RLSを調査。整合性・設計・セキュリティ問題を報告 | Phase 1 |
| `sweep-types` | haiku | 型定義・mappers・DB列・UIプロップスを縦断調査。層をまたぐ型不一致・欠落を報告 | Phase 1 |
| `completeness-critic` | sonnet | 未調査モダリティ・未検証クレーム・未読ソースを検出。網羅性チェック・終了判定 | Phase 1 / Phase 1深掘り |
| `proposer` | sonnet | 設計アプローチを1案提案（スタンス指定で起動） | Phase 1深掘り |
| `judge-panel` | sonnet | 複数の設計提案を評価・採点し、synthesis（統合提案）を作成。読み取り専用 | Phase 1深掘り |
| `adversarial-verify` | opus | Sweep指摘に反論を試み、偽陽性を除去。読み取り専用 | Phase 1深掘り |
| `contract-writer` | sonnet | src/types/ の型定義・APIインターフェース型を先行確定。implementerへの「契約」を書く | Phase 3 |
| `implementer` | sonnet | TDD実装（RED→GREEN→REFACTOR）。テスト削除・期待値改ざん禁止 | Phase 3 |
| `integrator` | sonnet | マイグレーション適用確認・共有ファイルの結線・npm test/lint確認 | Phase 4 |
| `reviewer` | sonnet | TDD品質規約検証・4観点指摘（正しさ/仕様カバレッジ/重複/型安全）読み取り専用 | Phase 5 |

## プロジェクト固有スキル（`.claude/skills/`）

| スキル | 呼び出し方 | 役割 |
|---|---|---|
| `feature-spec` | `/feature-spec` | 調査結果から SPEC.md を生成（Phase 2） |
| `structured-review` | `/structured-review` | 最終構造化レビュー（Phase 5 後・人間が起動） |
| `e2e-runner` | `/e2e-runner` | E2Eテスト・スクリーンショット生成（随時） |
| `handoff-format` | 作業完了報告（PR本文・セッション終了報告）を書くとき | 引き継ぎメモの必須フォーマット（issue #542） |

## TRI/RISK 機械判定基準（AIDDパイプライン採用条件）

変更が以下の**いずれか**に触れる場合、Sレーン（軽量レーン）は禁止。必ず M/L 扱いとし、RISK=はい と判定する：

- `supabase/migrations/` 配下のファイル
- `src/lib/supabase/` 配下のファイル
- `middleware.ts` / `proxy.ts`（プロジェクト内のすべてのmiddleware/proxy。proxy.tsはNext.js 16でmiddleware.tsから改名された同一ファイル規約。issue #681）
- パス・ファイル名・変更内容が以下のドメインに関わるファイル：
  **auth / facility / tenant / organization / inventory / RLS / policy**

この判定は人間の裁量で緩めない（機械判定）。迷ったら高リスク側に倒す。

## テスト環境・データ衛生ルール

- **E2E/BSGはテスト専用Supabaseのみに接続する。** 接続情報は `.env.test` に置く（`.env.test.example` 参照）。
  `NODE_ENV=test` のため `.env.local`（本番）は読み込まれず、さらに `e2e/env-guard.ts` が
  許可ホスト以外（＝本番URL・本番service role実行）を**即失敗**させる
- **認証ファイル（`e2e/.auth/user.json`）の漏洩チェックはCI側で行う**（`.github/workflows/ci.yml`の
  hooks-testジョブ。BSG（ローカルゲート）ではチェックしない方針）
- **E2E/integrationテストのCI自動実行はmainへのpush後と手動起動（workflow_dispatch）のみ**
  （2026-08-25、Actions無料枠対応）。PR段階では `npm run test:e2e` / `npm run test:integration` を
  ローカル実行で代替する
- **seed・スクリーンショット・E2E失敗ログ・issue添付に実在施設名・実データを入れない。**
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、`e2e-test-user@example.com`）を使う

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| `CLAUDE.md` | Phase 1-5 の詳細フロー・絶対ルール |
| [`docs/agents/common.md`](docs/agents/common.md) | 全AIエージェント共通ルール・**引き継ぎフォーマット**（作業完了時は必読） |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `.claude/settings.json` | Bash/MCP 権限リスト |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
