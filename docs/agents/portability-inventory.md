# 多リポジトリ展開に向けた棚卸し（issue #535）

issue #535「AIDDフレームワークの多リポジトリ展開に向けた棚卸し」の記録先。1回のセッションで
完成させる性質のものではなく、通常のAIDD作業を進めながら気づいた分類を随時この3表へ追記していく
たたき台（2026-08-01時点、issue #578/#579/#569残タスクの作業をきっかけに初版を作成）。

「1週間ほど棚卸しした後にレビューし、汎用プラグイン化に着手する価値があるか判断する」という
issue本文の進め方は変えていない。本ファイルはその判断材料を溜める置き場。

## ドメイン非依存と考えられる部分

構造・パターンそのものは他リポジトリでも再利用できそうな部分。

| 項目 | 所在 | 備考 |
|---|---|---|
| Phase骨格（調査→仕様→実装→統合→検証、停止①②） | ルート`CLAUDE.md`「フロー（骨格）」 | フェーズの区切り方・人間レビューを挟む位置という設計思想自体はドメイン非依存 |
| TRI/RISK分類エンジンの構造（`classifyRoute`の4分岐: meta/confirm/deep/light、パスベース優先ロジック） | `.claude/workflows/lib/router-risk.js` | ロジック（changedFilesがあればパス優先、無ければキーワードフォールバック＋confirm、メタ改修は先に判定）は汎用。中身の`RISK_KEYWORDS`はドメイン固有（下記「判断が難しい部分」参照） |
| gap check方式（before/expected件数の事前記録→事後突合というパターン） | `scripts/record-gap-check-state.sh`・`scripts/check-gap-check-state.sh` | 「記録漏れを期待値と実測値の突合で機械検知する」という方式自体は汎用 |
| subagent役割分担パターン（sweep-* / reviewer / implementer / judge-panel / proposer / adversarial-verify / completeness-critic / contract-writer） | `.claude/agents/*.md` | 役割名・責務の切り方（発見/実装/レビュー/統合を分離する）は汎用。sweep-db/sweep-uiのような軸の中身はスタック依存 |
| canonical eventのAdapterパターン（複数の自己申告ログを1つの正規化型へ変換して統合参照する設計） | `scripts/lib/canonical-event.ts`（issue #569） | 「書き込み側は無改修のまま読み取り側だけ統合する」という設計判断自体は汎用 |
| recovery-queueの設計（検知→queue登録→次回セッション冒頭で自動表示→resolve） | `docs/agents/recovery-queue.md`（issue #523・#579） | 検知と復旧を疎結合にするパターンは汎用 |
| アクチュエータ分類の考え方（block/ask/自動復旧/warning-onlyの4分類） | `docs/agents/actuator-inventory.md`（issue #578） | 検知hookを追加する際の設計チェックリストとして汎用 |
| Loop Until Dry・budgetガードの考え方 | `.claude/workflows/lib/budget-guard.js` | 「収束するまで/予算内で繰り返す」制御パターンは汎用 |
| fault injection訓練という手法（実際にゲートを壊してblockedを返すか実測する） | `docs/agents/fault-injection-drill.md`（issue #395） | 単体テストのgreenを信用せず実行パスを実測するという方針は汎用 |
| 検知手段・アクチュエータを先に決めてからルールを書くという原則 | `docs/agents/decisions.md`（issue #339・#578） | 運用ルールの設計原則自体はツール・ドメインに依存しない |

## このリポジトリ・スタック固有と考えられる部分

| 項目 | 所在 | 備考 |
|---|---|---|
| `npm test` / `npm run lint`コマンド体系 | ルート`CLAUDE.md`「プロジェクト設定」 | Node/npmプロジェクト前提。他言語スタックでは丸ごと差し替えが必要 |
| Supabase RLS/migration概念、`supabase db diff`等のCLI呼び出し | `supabase/migrations/`・`.claude/rules/db-schema.md` | DBがSupabase(PostgreSQL)であることに強く依存 |
| facility/tenant/organization/inventory等のドメインキーワード | `.claude/workflows/lib/router-risk.js`の`RISK_KEYWORDS`一部 | 医療在庫管理ドメイン固有の語彙 |
| GitHub issue/PR連携（`gh`コマンド依存） | `docs/agents/common.md`各所、`scripts/check-branch-pr-status.sh`等 | GitHub以外のissue tracker（Linear等）を使うリポジトリでは差し替えが必要 |
| Next.js App Router固有の構造（`src/app/`・`middleware.ts`） | ルート`CLAUDE.md`「プロジェクト設定」 | フレームワーク固有のディレクトリ規約 |
| e2e/env-guard.ts・Playwright認証状態（`--isolated --storage-state`） | `e2e/`配下、`.claude/rules/e2e-test-hygiene.md` | Playwright前提。本番Supabase分離の実装もこのスタック向け |
| `.env.local`/`.env.test`分離と`scripts/create-worktree.sh`の自動コピー | `docs/agents/common.md`「ブランチ運用ルール」 | Next.js/Supabaseの環境変数運用に特化 |

## 判断が難しい・要検証の部分

| 項目 | 所在 | 論点 |
|---|---|---|
| `RISK_KEYWORDS`のうち`auth`/`rls`/`policy`と`facility`/`tenant`/`organization`/`inventory`の混在 | `.claude/workflows/lib/router-risk.js` | 前者はマルチテナントSaaS全般に通用しそうな汎用概念だが、後者はこのドメイン固有。同じ配列に混在しており、汎用部分だけ抽出する設計（例: ドメイン固有語彙を外部設定ファイル化）が必要かは未検証 |
| Workflow DSLの制約（filesystem API不可）への回避策群 | `docs/agents/tooling-decisions.md`「ツール制約回避のload-bearing workaround棚卸し」 | 制約自体はClaude Code側（ツール共通）だが、回避策の実装（bashスクリプトへの委譲パターン等）はこのリポジトリの実装に密結合しており、他リポジトリでも同じ回避策がそのまま使えるかは未検証 |
| `~/write_aidd_stats.sh`・`~/.claude/pending_issues.jsonl`等、リポジトリ外（ホームディレクトリ）に置かれた個人スクリプト・設定 | ルート`CLAUDE.md`「AIDD stats 書き出しルール」等 | リポジトリに含まれないため「移植」の対象なのかどうか自体が論点（ユーザー個人の運用習慣なのか、フレームワークの一部なのか） |
| sweep-db/sweep-ui/sweep-types/sweep-dataという4軸分類 | `.claude/agents/sweep-*.md` | 「UI/データ/DB/型」という軸自体はNext.js+Supabase構成に最適化されており、他スタック（例: モバイルアプリ、バッチ処理基盤）でも同じ4軸が意味を持つかは未検証 |

## 次にやること

- 通常のAIDD作業（Phase 1-5・issue対応）を進める中で、新しく追加/変更したファイルがどの区分に
  当たるかをこの3表に追記していく
- 1週間分たまったら、issue #535のレビュー基準（汎用プラグイン化に着手する価値があるか、移植先候補
  リポジトリの目星がついたか）に沿って判断する
