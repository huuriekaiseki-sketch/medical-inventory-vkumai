<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# このリポジトリの AI エージェント設定ガイド

医療在庫管理アプリ (medical-inventory-vkumai) における Claude Code のエージェント・スキル設定。
**詳細は [`docs/ai-config-map.md`](docs/ai-config-map.md) を参照。**

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
| `implementer` | opus | TDD実装（RED→GREEN→REFACTOR）。テスト削除・期待値改ざん禁止 | Phase 3 |
| `reviewer` | sonnet | TDD品質規約検証・4観点指摘（正しさ/仕様カバレッジ/重複/型安全）読み取り専用 | Phase 5 |

## プロジェクト固有スキル（`.claude/skills/`）

| スキル | 呼び出し方 | 役割 |
|---|---|---|
| `feature-spec` | `/feature-spec` | 調査結果から SPEC.md を生成（Phase 2） |
| `structured-review` | `/structured-review` | 最終構造化レビュー（Phase 5 後・人間が起動） |
| `e2e-runner` | `/e2e-runner` | E2Eテスト・スクリーンショット生成（随時） |

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| `CLAUDE.md` | Phase 1-5 の詳細フロー・絶対ルール |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `.claude/settings.json` | Bash/MCP 権限リスト |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
