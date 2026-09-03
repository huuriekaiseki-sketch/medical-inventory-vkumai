# テスト一覧（何を・いつ・なぜ）

このリポジトリのテスト種別ごとに「いつ回るか」「なぜ要るか」「証跡はどこか」を1つの表にした正本。
引き継ぎメモ（`handoff-format` スキル）の「04 どう確認したか」の行は、この一覧の「毎回」「変更時」の
種別に揃えて書く。整合は `scripts/check-test-matrix.test.sh`（CI の `hooks-test` ジョブ）が機械検査する。

設計書: [`../superpowers/specs/2026-09-02-test-matrix-design.md`](../superpowers/specs/2026-09-02-test-matrix-design.md)（PR①）、
[`../superpowers/specs/2026-09-04-derive-test-selection-design.md`](../superpowers/specs/2026-09-04-derive-test-selection-design.md)（PR②: derive キー列）。
後続予定: auth / RLS / facility 境界に限定した約束カタログ（PR③）。

今回の変更で何が必須かは、人が表を読んで決めるのではなく `bash scripts/derive-test-selection.sh
[base] --format table` の出力を 04 表に貼る（「➖ 今回不要」の理由はここが出す）。判定は
`scripts/lib/derive-test-selection.rules.mjs`（この一覧の derive キーと 1:1 のルール表）と、
高リスクパス判定の正本 `.claude/workflows/lib/router-risk.js` が行う。

## 更新ルール

- 状態を ⬜→✅ / 🟡→✅ に変える PR は、証跡列を必ず埋める（証跡 `—` の ✅ は構造テストが拒否する）。
- 証跡列にパスを書くときはバッククォートで囲む（構造テストが実在を検査する。テストを消したら一覧も直す）。
  CI ジョブは「CI `ジョブ名` ジョブ」と書く（`.github/workflows/*.yml` の `jobs:` に実在するかを検査する）。
- ✅ 以外（➖ / 🟡 / ⬜）の行は理由列を必ず埋める（空・`—` は構造テストが拒否する）。
- 理由・証跡・コマンドの中に `|` を書かない（列がずれた行は構造テストが違反として数える）。
- derive キー列は `scripts/lib/derive-test-selection.rules.mjs` のキーと 1:1（種別名・実施タイミングも
  一致。構造テストが双方向に突合する）。derive が判定しない行（➖ 対象外・一度きり等）だけ `—` と書く。
  種別を増やすときはルール表にも同時に足す（片方だけだと構造テストが拒否する）。
- 状態の凡例: ✅ ある（証跡付き）/ 🟡 一部ある（欠けている点は理由列）/ ⬜ 未整備（まだ用意していない。
  時期とやり方は決めてある）/ ➖ 対象外（やらない理由を理由列に）。⬜ は「失敗」や「問題あり」ではない。
- 実施タイミングは4語のみ: 毎回（CI が全 PR で自動）/ 変更時（CI の paths フィルタ・高リスク判定・
  ローカル実行義務）/ 節目（main マージ後・日次 cron・四半期・外部公開前）/ 一度きり（受入時に証跡を残して終わり）。
- 「変更時」のうち CI の paths フィルタで表せない内容ベースの判定（auth / facility / tenant /
  organization / inventory / RLS / policy に関わる変更）は、引き続き
  [`../../.claude/rules/db-schema.md`](../../.claude/rules/db-schema.md) のローカル実行義務に依存する。

## 一覧（2026-09-02 時点）

| 種別 | 状態 | 実施タイミング | トリガー | 理由 | 証跡 | derive キー | 相場 | コマンド |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 型検査 | ✅ | 毎回 | 全 PR | `tsc --noEmit`。テストコードも対象 | CI `typecheck` ジョブ（`.github/workflows/ci.yml`） | typecheck | Google Small / pre-commit 段 | `npm run typecheck` |
| lint | ✅ | 毎回 | 全 PR | eslint、warning 0 件で固定 | CI `lint` ジョブ（`.github/workflows/ci.yml`） | lint | pre-commit 段 | `npm run lint` |
| unit（UI・データ層・API Route） | ✅ | 毎回 | 全 PR | vitest + jsdom。DB 非接続のモックテスト。`src/` 配下の `__tests__/` | `src/__tests__/`、`src/components/`・`src/lib/`・`src/app/` 配下の各 __tests__ ディレクトリ、CI `test` ジョブ（`.github/workflows/ci.yml`） | unit | Google Small / ピラミッド最下段 | `npm test` |
| build | ✅ | 毎回 | 全 PR | Next.js 本番ビルドが通る | CI `build` ジョブ（`.github/workflows/ci.yml`） | build | release 前段 | `npm run build` |
| migration 静的テスト | ✅ | 毎回 | 全 PR | migration SQL の文字列検査（RLS 有効化・GRANT・search_path・AAL2 条件等）。実 DB には繋がない | `supabase/migrations/__tests__/`、CI `test` ジョブ | migration-static | — | `npm test` |
| DB 制約 ratchet | ✅ | 毎回 | 全 PR | 後付け FK 列のカーディナリティ未宣言・制約 migration の実 DB 統合テスト欠落を ratchet で止める（issue #675） | `supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts`、`scripts/check-constraint-coverage.sh` | constraint-ratchet | — | `npm test` / `bash scripts/check-constraint-coverage.sh` |
| ワークフロー同期テスト | ✅ | 毎回 | 全 PR | Workflow DSL 側のインライン複製と `lib/` 正本の乖離検知（prompt sync・router-risk sync 等） | `.claude/workflows/lib/__tests__/`、CI `test` ジョブ | workflow-sync | — | `npm test` |
| hook 回帰 | ✅ | 毎回 | 全 PR | hook スクリプトの入出力回帰と設定分離の構造テスト | `scripts/` 配下の `*.test.sh`、`scripts/lib/` 配下の `*.test.sh`、CI `hooks-test` ジョブ（`.github/workflows/ci.yml`） | hook-regression | — | `for t in scripts/*.test.sh scripts/lib/*.test.sh; do bash "$t"; done` |
| 認証ファイル漏洩チェック | ✅ | 毎回 | 全 PR | `e2e/.auth` 配下の認証状態ファイルがコミットされていない | CI `hooks-test` ジョブ内ステップ（`.github/workflows/ci.yml`） | auth-file-leak | ASVS V2 | `git ls-files e2e/.auth` |
| RLS/IDOR 統合（実 DB） | ✅ | 変更時 | CI paths: `supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/proxy.ts`・`**/middleware.ts`。内容ベースの高リスク変更はローカル実行義務 | ローカル Supabase に本人・他人・admin・viewer でアクセスし、他施設データが取れないことを実測。PR ごとに回すと Actions 無料枠が枯渇するため高リスクパスに限定（2026-08） | `supabase/__tests__/integration/`、`.github/workflows/integration-gate.yml` | rls-idor-integration | OWASP ASVS V4（アクセス制御）/ Google Medium | `npm run test:integration` |
| 生成型の鮮度 | ✅ | 変更時 | RLS/IDOR 統合と同じ paths | `supabase gen types` の結果と `src/lib/supabase/` の生成型が一致する | `scripts/check-generated-supabase-types.sh`、`.github/workflows/integration-gate.yml` | generated-types | — | `bash scripts/check-generated-supabase-types.sh` |
| 直接攻撃の実測（テスト外） | 🟡 | 変更時 | auth / 認可 / RLS に触れた PR | テスト green だけでは「修正が効いていない」型を見逃すため、テストを介さず他テナント ID で直接叩く。実施記録は引き継ぎメモ 03 欄の自由記述のみで、機械検知は無い | `.claude/skills/handoff-format/SKILL.md` の 03 欄、`docs/agents/known-failure-patterns.md` | direct-attack | ASVS V4 | `(手動) 他施設ユーザーで API Route / RPC を直接呼び、拒否を確認する` |
| E2E（Playwright） | ✅ | 節目 | main へ push 後、または `workflow_dispatch`。PR 段階はローカル実行 | 施設境界・注文・互換性のスモーク。1 回の消費分数が最大級のため PR 自動実行は廃止（2026-08-25） | `e2e/`、`.github/workflows/e2e.yml` | e2e | Google Large | `npm run test:e2e` |
| スキーマドリフト検知 | ✅ | 節目 | 日次 cron（DB 側 pg_cron → GitHub Actions） | migration 外で入った本番スキーマ変更を検知し issue 化する（issue #305） | `.github/workflows/schema-drift-check.yml`、`supabase/migrations/__tests__/schema_drift_detection.test.ts` | schema-drift | — | `(自動) cron。手動は workflow_dispatch` |
| agents baseline 鮮度 | ✅ | 変更時 | CI paths: `.claude/agents/**`・`.claude/workflows/**` | model / effort を変えた PR で効果測定の before スナップショットが抜けていないか（issue #429）。warning のみでブロックしない | `.github/workflows/agent-baseline-check.yml`、`docs/agents/baselines/` | agents-baseline | — | `(自動) PR で警告` |
| ワークフロープロンプト eval | 🟡 | 変更時 | `.claude/workflows/**` の変更 | 実エージェント呼び出しを伴うため CI では回さず、`eval-runs.jsonl` の更新有無だけを CI が警告する（issue #391・#496）。実行は人が起動する | `scripts/eval-workflow-prompts.sh`、`docs/agents/eval-runs.jsonl`、`.github/workflows/eval-runs-freshness-check.yml` | workflow-eval | — | `bash scripts/eval-workflow-prompts.sh` |
| fault injection 訓練（ゲート） | 🟡 | 節目 | 四半期、または `aidd-phase2.js` の Spec Check / Manifest Check プロンプト変更時 | deny-by-default ゲートが本当に `blocked` を返すかを実 Workflow で実測。実施義務自体の機械強制は無い（検知手段のないルール棚卸しに記載） | `docs/agents/fault-injection-drill.md` の実施記録、`scripts/aidd-fault-injection-setup.sh` | fault-injection-drill | Chaos Engineering（縮小版） | `(手動) fault-injection-drill.md の手順` |
| hook 実機発火 | 🟡 | 変更時 | hook / settings / `.codex/hooks.json` の変更 | shell テスト green のまま Codex 側 hook が無言死する構造を実測済みのため、新規セッションで発火を確認する。実施の機械強制は無い | `docs/agents/claude-codex-coexistence-template.md` の実機検証手順 | hook-live | — | `(手動) 新規セッションで hook 発火を確認` |
| 冪等性（再送・二重実行） | ⬜ 未整備 | 変更時 | 注文・返却系 RPC の変更 | 同じ入力で RPC を2回呼んだとき件数・状態が変わらないかは個別テストに散在し、種別として整理していない | — | idempotency | riff-gear `tests/idempotency/` | — |
| 同時実行 | ⬜ 未整備 | 変更時 | 同一注文・同一在庫行を複数ユーザーが同時に更新する変更 | 楽観ロック・一意制約による競合の扱いを種別として整理していない | — | concurrency | riff-gear `tests/concurrency/` | — |
| 障害注入（外部依存停止） | ⬜ 未整備 | 節目 | 依存 major 更新、外部公開前 | Supabase 停止・タイムアウト時に UI / API Route がハングせず失敗を返すか未確認 | — | fault-injection | Chaos Engineering（縮小版） | — |
| 復旧手順（ランブック） | 🟡 | 節目 | 障害発生時、公開前 | Workflow 中断の再開手順と recovery-queue はあるが、本番 DB・認証（MFA/AAL2）障害時の手順は無い | `docs/agents/workflow-resume-runbook.md`、`docs/agents/recovery-queue.md` | runbook | SRE ランブック | — |

## 節目のイベント

| イベント | 実施する種別 |
| --- | --- |
| main へのマージ後 | E2E |
| 毎日 | スキーマドリフト検知 |
| 依存の major 更新 | 障害注入、RLS/IDOR 統合、E2E、build |
| 四半期 | fault injection 訓練、hook 実機発火（ゲート訓練）、復旧手順の見直し |
| 外部公開の前 | 障害注入、復旧手順 |
