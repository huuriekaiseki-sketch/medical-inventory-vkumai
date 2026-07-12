# 共通ルール（全AIエージェント共通）

このファイルは Claude Code・Codex 等、このリポジトリで作業するすべての AI エージェントが
従うべき共通ルールを定義する。ツール固有の設定（サブエージェント・スキル・ワークフロー・
開発フローのオーケストレーション等）は各ツールの入口ファイル（`CLAUDE.md` / `AGENTS.md`）
側を参照すること。

- ドメイン用語（facility・price等が何であるか）は [`domain.md`](./domain.md) を参照
- 各ルールが「なぜ」その設計になったかは [`decisions.md`](./decisions.md) を参照
- 過去に実際に再発した実装ミスのチェックリストは [`known-failure-patterns.md`](./known-failure-patterns.md) を参照（レビュー・Sweep系エージェントは必読）

## Next.js バージョンに関する注意

This version has breaking changes — APIs, conventions, and file structure may all differ from
your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing
any code. Heed deprecation notices.

## TRI/RISK 機械判定基準（AIDDパイプライン採用条件）

変更が以下の**いずれか**に触れる場合、Sレーン（軽量レーン）は禁止。必ず M/L 扱いとし、RISK=はい と判定する：

- `supabase/migrations/` 配下のファイル
- `src/lib/supabase/` 配下のファイル
- `middleware.ts`（プロジェクト内のすべての middleware）
- パス・ファイル名・変更内容が以下のドメインに関わるファイル：
  **auth / facility / tenant / organization / inventory / RLS / policy**

この判定は人間の裁量で緩めない（機械判定）。迷ったら高リスク側に倒す。
理由は [`decisions.md`](./decisions.md#なぜtririsk判定を機械判定にし人の裁量で緩めないことにしたか) を参照。

## テスト環境・データ衛生ルール

- **E2E/BSGはテスト専用Supabaseのみに接続する。** 接続情報は `.env.test` に置く（`.env.test.example` 参照）。
  `NODE_ENV=test` のため `.env.local`（本番）は読み込まれず、さらに `e2e/env-guard.ts` が
  許可ホスト以外（＝本番URL・本番service role実行）を**即失敗**させる
- **認証ファイル（`e2e/.auth/user.json`）の漏洩チェックはCI側で行う**（`.github/workflows/e2e.yml`）。
  BSG（ローカルゲート）ではチェックしない方針
- **seed・スクリーンショット・E2E失敗ログ・issue添付に実在施設名・実データを入れない。**
  施設名・ユーザー名・在庫品目などはすべてダミー（例: `テスト施設A`、`e2e-test-user@example.com`）を使う

## DBスキーマ変更ルール

- **DBスキーマ変更は必ず `supabase/migrations/` 配下のマイグレーションファイル経由で行う。**
  `execute_sql` 等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）
- マイグレーション外で本番/リモートDBに存在するスキーマ変更（トリガー・関数等）を発見した場合は、
  差分をキャッチアップ用マイグレーションとして必ず記録してから作業を進める
- 理由（過去のスキーマドリフト事例）は [`decisions.md`](./decisions.md#なぜdbスキーマ変更をmigrationファイル経由に限定し直接ddl実行を禁止したか) を参照

## ブランチ運用ルール

- **新しいissue・機能の作業を始める前に、現在のブランチが別issue用の未マージPRの対象になっていないか確認する**（`git branch --show-current` → `gh pr list --head <branch>`）。
  なっていた場合は、着手前に `git checkout -b <new-branch> main` で新しいブランチを切ってから進める。
  1つのPRに無関係なissueのコミットが混ざると、レビュアーが混乱し、片方だけ却下・差し戻しになった際に切り分けられなくなる

## loop-observabilityログの記録漏れ検知

- AIDDフロー（`aidd-phase2.js` 等）は reviewer/implementer/judge-panel を呼ぶたびに
  `scripts/log-loop-observability.sh` を呼び出す想定だが、これはエージェントへの自然言語指示に
  依存しており強制力がない（Workflow DSL自体がfilesystem API不可のため、ワークフロー本体側から
  機械的にログを書き込むことはできない）。2026-07-07以降、実際に記録が5日分丸ごと欠落していた
  事例がある。理由は [`decisions.md`](./decisions.md) 参照。
- **AIDDフロー（Phase 2以降）を実行する前後で、必ず以下を行うこと。**
  1. 実行前に `wc -l logs/loop-observability.jsonl` で行数を記録する（ファイルが無ければ0）
  2. フロー完了後、戻り値の `stats.expectedLoopObservabilityRecords` を確認する
  3. `scripts/check-loop-observability-gap.sh --before <1の値> --expected <2の値>` を実行する
  4. `hasGap: true`（exit 1）になった場合、記録漏れとして扱い、issue化するか原因を調査する
- これは「記録漏れを機械的に検知する」ものであり、記録そのものを保証する仕組みではない
  （エージェント任せの記録に依存する構造自体の解消は別途検討中）。

## 重要ファイルへのパス

| ファイル | 目的 |
|---|---|
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
