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
| TRI/RISK分類エンジンの構造（`classifyRoute`の4分岐: meta/confirm/deep/light、パスベース優先ロジック） | `.claude/workflows/lib/router-risk.js` | ロジック（changedFilesがあればパス優先、無ければキーワードフォールバック＋confirm、メタ改修は先に判定）は汎用。2026-09-05（issue #420 v1 セット B）に語彙を分離し、エンジンの既定値`DEFAULT_RISK_CONFIG`は汎用語（auth / rls / policy / migration）のみ。固有語は`aidd.config.json`へ（下表） |
| 導入先アダプター設定の形（`aidd.config.json` と `scripts/lib/aidd-config.schema.json`。risk / readonlyAgentTypes / commands / docs の 4 キー、配列は既定値に足すだけで消せない） | `aidd.config.json`、`scripts/lib/aidd-config.schema.json`、`.claude/workflows/lib/__tests__/aidd-config.test.js` | issue #420 v1 セット B。形式・スキーマ・「既定値を狭めない」検査は汎用。値は固有（下表）。Workflow DSL はファイルを読めないため `aidd-phase1-router.js` は同じ値を `LOCAL_RISK_CONFIG` としてインラインで持ち、同期テストで突き合わせる。hook 側（`check-readonly-bash.sh`・`check-run-manifest-presence.sh`・`ai-check-suggest.sh`・`check-domain-decisions-suggest.sh`）は `scripts/lib/aidd-config.sh` 経由で読み、設定が無ければ各 hook が持つ汎用既定値だけで判定する（緩まない） |
| gap check方式（before/expected件数の事前記録→事後突合というパターン） | `scripts/record-gap-check-state.sh`・`scripts/check-gap-check-state.sh` | 「記録漏れを期待値と実測値の突合で機械検知する」という方式自体は汎用 |
| subagent役割分担パターン（sweep-* / reviewer / implementer / judge-panel / proposer / adversarial-verify / completeness-critic / contract-writer） | `.claude/agents/*.md` | 役割名・責務の切り方（発見/実装/レビュー/統合を分離する）は汎用。sweep-db/sweep-uiのような軸の中身はスタック依存 |
| canonical eventのAdapterパターン（複数の自己申告ログを1つの正規化型へ変換して統合参照する設計） | `scripts/lib/canonical-event.ts`（issue #569） | 「書き込み側は無改修のまま読み取り側だけ統合する」という設計判断自体は汎用 |
| recovery-queueの設計（検知→queue登録→次回セッション冒頭で自動表示→resolve） | `docs/agents/recovery-queue.md`（issue #523・#579） | 検知と復旧を疎結合にするパターンは汎用 |
| アクチュエータ分類の考え方（block/ask/自動復旧/warning-onlyの4分類） | `docs/agents/actuator-inventory.md`（issue #578） | 検知hookを追加する際の設計チェックリストとして汎用 |
| Loop Until Dry・budgetガードの考え方 | `.claude/workflows/lib/budget-guard.js` | 「収束するまで/予算内で繰り返す」制御パターンは汎用 |
| fault injection訓練という手法（実際にゲートを壊してblockedを返すか実測する） | `docs/agents/fault-injection-drill.md`（issue #395） | 単体テストのgreenを信用せず実行パスを実測するという方針は汎用 |
| 検知手段・アクチュエータを先に決めてからルールを書くという原則 | `docs/agents/decisions.md`（issue #339・#578） | 運用ルールの設計原則自体はツール・ドメインに依存しない |
| テスト一覧の形式（列・状態4値・実施タイミング4語）と構造テスト | `docs/agents/test-matrix.md`の列構成、`scripts/check-test-matrix.test.sh` | riff-gear → kojigyo → vkumai と3回持ち回った。行の中身は固有（下表） |
| derive のエンジン（入力解析・classifyRoute 呼び出し・required/not_required/milestone の評価・04 表出力） | `scripts/lib/derive-test-selection.mjs`、`scripts/derive-test-selection.sh` | パス表を一切持たない。派生先はルール表だけを書き換える設計（2026-09-04） |
| 引き継ぎメモ 04 の4値検知（Stop hook の行名指し警告） | `scripts/check-handoff-format.sh` | 「どう確認したか」節の表行の状態列を見るだけで、種別名には依存しない |
| 約束カタログの形式（9 列・`P-`3 桁・番号帯）と双方向の構造テスト | `docs/agents/promise-catalog.md`の列構成、`scripts/check-promise-catalog.test.sh` | 「ID が守るテストのファイル内に実在」「孤児 ID 禁止」の検査は言語・フレームワークに依存しない（検索対象の拡張子だけ差し替える） |
| グラフマニフェストのスキーマ（nodes / edges / humanGates / budgets、blocked エッジは returnsTo 必須）と同期テスト・生成図の仕組み | `.claude/workflows/graph/aidd-graph.mjs`、`.claude/workflows/lib/__tests__/graph-manifest-sync.test.js`、`scripts/lib/render-aidd-graph.mjs` | issue #710。スキーマと「JS から静的抽出して突合する」方式は汎用。nodes / edges の中身（sweep 4 軸・Review 4 観点・予算値）はリポジトリ固有 |
| 常時ロード量の予算（CLAUDE.md + `@import` 連鎖 + 非スコープ rules の文字数上限）とスキル本文の文字数上限 | `scripts/check-claude-md-size.sh`、`scripts/check-skill-size.test.sh` | issue #711・#716。「起動時に必ず読まれる文字数を測って上限で止める」方式は汎用。上限値（24,000 / 5,000 文字）は各リポジトリの実測で決め直す |
| compaction 後の状態再注入（SessionStart `compact` matcher で実行状態だけを再注入し、警告系 hook は startup に限定） | `scripts/reinject-aidd-run-state.sh`、`.claude/settings.json` の SessionStart 2 エントリ、`scripts/check-session-start-matchers.test.sh` | issue #712。「要約で消える状態をディスクから読み直す」設計は汎用。再注入する内容（run-manifest / agent-progress / recovery-queue）はこのリポジトリの観測ファイルに依存 |
| 読み取り専用ロールの Bash ガード（settings.json の PreToolUse で `agent_type` を見て書き込み系コマンドを deny） | `scripts/check-readonly-bash.sh`、`READONLY_AGENT_TYPES` | issue #713。「ロール名の集合 × コマンド分類」で deny する方式は汎用。ロール名一覧（sweep-* / reviewer 等）はエージェント構成に依存 |
| docs 整合性検査（相対リンク・見出しアンカー・パス言及の実在、歴史的マーカー付きは免除） | `scripts/lib/check-docs-integrity.mjs`、`.github/workflows/docs-integrity-check.yml` | issue #714。検査の 3 種と GitHub の slug 規則は汎用。`PATH_MENTION_PREFIXES`（`scripts/` `supabase/` 等）と歴史的マーカー語（削除済み・廃止済み等）はリポジトリ固有 |
| eval fixture の中立性検査（fixture コードに「ベンチマーク用・意図的」等の自己申告語を書かせない）と、recall 判定器の「非 JSON 応答は生出力で判定」「期待パスの配列（いずれか一致）」 | `scripts/check-eval-fixtures-neutral.test.sh`、`scripts/eval-sweep-recall.sh`、`scripts/lib/judge-sweep-recall.py` | issue #731。「評価対象に正解を教えない」「MISS = 見落としではない、判定器・fixture・エージェントを生出力で切り分ける」という原則は LLM 評価一般に通用する。禁止語の一覧は日本語運用固有 |
| 実行痕跡の鮮度チェックを warning でなく失敗にし、免除は PR 本文の申告（`eval-skip: <理由>`）に限定する運用 | `scripts/check-eval-runs-freshness.sh`、`.github/workflows/eval-runs-freshness-check.yml` | issue #496。「`::warning::` は run を開かないと見えず 3 PR で無視された」という教訓と、本文申告による免除の形は汎用 |

## このリポジトリ・スタック固有と考えられる部分

| 項目 | 所在 | 備考 |
|---|---|---|
| `npm test` / `npm run lint`コマンド体系 | ルート`CLAUDE.md`「プロジェクト設定」 | Node/npmプロジェクト前提。他言語スタックでは丸ごと差し替えが必要 |
| Supabase RLS/migration概念、`supabase db diff`等のCLI呼び出し | `supabase/migrations/`・`.claude/rules/db-schema.md` | DBがSupabase(PostgreSQL)であることに強く依存 |
| facility/tenant/organization/inventory等のドメインキーワードと`supabase/migrations/`・`src/lib/supabase/`接頭辞 | `aidd.config.json`の`risk`（2026-09-05 に`router-risk.js`の`RISK_KEYWORDS`等から移動）、`aidd-phase1-router.js`の`LOCAL_RISK_CONFIG`（インライン複製） | 医療在庫管理ドメインと Supabase スタック固有の語彙。プラグイン生成時は`@aidd-local-config`マーカー区間を空にする |
| GitHub issue/PR連携（`gh`コマンド依存） | `docs/agents/common.md`各所、`scripts/check-branch-pr-status.sh`等 | GitHub以外のissue tracker（Linear等）を使うリポジトリでは差し替えが必要 |
| Next.js App Router固有の構造（`src/app/`・`proxy.ts`/旧`middleware.ts`） | ルート`CLAUDE.md`「プロジェクト設定」 | フレームワーク固有のディレクトリ規約 |
| e2e/env-guard.ts・Playwright認証状態（`--isolated --storage-state`） | `e2e/`配下、`.claude/rules/e2e-test-hygiene.md` | Playwright前提。本番Supabase分離の実装もこのスタック向け |
| `.env.local`/`.env.test`分離と`scripts/create-worktree.sh`の自動コピー | `docs/agents/common.md`「ブランチ運用ルール」 | Next.js/Supabaseの環境変数運用に特化 |
| テスト一覧の行（種別・トリガー・証跡・コマンド） | `docs/agents/test-matrix.md`の各行 | RLS/IDOR 統合・スキーマドリフト等は Supabase 前提。kojigyo（RAG）には golden set・資料鮮度など vkumai に無い行があり、それらは vkumai を経由せず RAG 系の派生先へ持っていく |
| derive のルール表（derive キー・trigger・not_required の理由・コマンド） | `scripts/lib/derive-test-selection.rules.mjs` | 一覧の行と 1:1。高リスク判定は `router-risk.js` を参照するため、そちらの語彙にも依存する |
| 約束カタログの行（施設境界・AAL2・admin 境界の各約束） | `docs/agents/promise-catalog.md`の各行 | facility / is_facility_member / has_aal2 等はこのリポジトリの認可設計に固有。kojigyo（corpus の閲覧区分）とは中身が全く違う |
| Claude / Codex の二重管理（`.claude/skills` と `.agents/skills` のミラー、parity テストのスキルごとの同期単位、AGENTS.md / common.md の TRI/RISK 節の同期テスト） | `scripts/lib/claude-codex-skills-parity.test.ts`、`.claude/workflows/lib/__tests__/tri-risk-docs-sync.test.js` | issue #715・#719。Codex を併用しないリポジトリには不要。併用する場合も「どのスキルを完全一致にするか」は運用判断 |
| Stop hook が transcript から「セッション開始時刻」を取る方法（先頭 50 行のうち最初に `timestamp` を持つ行。`bridge-session` 行を読み飛ばす） | `scripts/check-aidd-stats-recorded.sh`、`scripts/check-aidd-phase-stats-recorded.sh`、`scripts/check-find-av-precision-recorded.sh` | Claude Code 本体の transcript 形式（`*.jsonl`、Remote Control 時の先頭行）に依存。本体更新で無音死しうるため、fail-open hook の生存確認（`logs/*.jsonl` の最終更新日）を節目で見る運用とセット |

## 判断が難しい・要検証の部分

| 項目 | 所在 | 論点 |
|---|---|---|
| `RISK_KEYWORDS`のうち`auth`/`rls`/`policy`と`facility`/`tenant`/`organization`/`inventory`の混在 | `.claude/workflows/lib/router-risk.js` | 前者はマルチテナントSaaS全般に通用しそうな汎用概念だが、後者はこのドメイン固有。同じ配列に混在しており、汎用部分だけ抽出する設計（例: ドメイン固有語彙を外部設定ファイル化）が必要かは未検証 |
| Workflow DSLの制約（filesystem API不可）への回避策群 | `docs/agents/tooling-decisions.md`「ツール制約回避のload-bearing workaround棚卸し」 | 制約自体はClaude Code側（ツール共通）だが、回避策の実装（bashスクリプトへの委譲パターン等）はこのリポジトリの実装に密結合しており、他リポジトリでも同じ回避策がそのまま使えるかは未検証 |
| `~/write_aidd_stats.sh`・`~/.claude/pending_issues.jsonl`等、リポジトリ外（ホームディレクトリ）に置かれた個人スクリプト・設定 | ルート`CLAUDE.md`「AIDD stats 書き出しルール」等 | リポジトリに含まれないため「移植」の対象なのかどうか自体が論点（ユーザー個人の運用習慣なのか、フレームワークの一部なのか） |
| sweep-db/sweep-ui/sweep-types/sweep-dataという4軸分類 | `.claude/agents/sweep-*.md` | 「UI/データ/DB/型」という軸自体はNext.js+Supabase構成に最適化されており、他スタック（例: モバイルアプリ、バッチ処理基盤）でも同じ4軸が意味を持つかは未検証 |

## 2026-09-05 時点の所見（issue #535 のレビュー用）

- 起票時の前提「移植先候補は未定」は変わった。riff-gear（EC）・cardiosearch（Codex 版）へ移植済みで、
  派生側からの逆輸入（hooks-test CI、マイグレーション番号衝突検知、`-- ROLLBACK:` 規約）も始まっている
  （issue #535 コメント 2026-08-24）。論点は「汎用化する価値があるか」から「本家⇔派生の双方向同期を
  どう設計するか（Plugin 化 #420 を含む）」へ移っている
- 2026-09-01〜05 に入った仕組み（上表の #710〜#731）は、いずれも「構造・検査方式は汎用、しきい値・
  語彙・ロール名は固有」という同じ切り口に収まった。分離の粒度は「エンジン（共通）とルール表（固有）」
  （derive の設計）で統一できる見込み
- 派生側で判明した差分（ドメインキーワード・コマンド・スタック依存部分）の反映は、riff-gear /
  cardiosearch がこの Mac のホーム直下に無いため未着手。両リポジトリの場所が分かり次第、上表の
  「固有」列を派生側の実値と突き合わせる

## 次にやること

- 通常のAIDD作業（Phase 1-5・issue対応）を進める中で、新しく追加/変更したファイルがどの区分に
  当たるかをこの3表に追記していく
- riff-gear / cardiosearch の実移植で判明した差分で「固有」列を更新する（場所の特定が先）
- issue #420（Plugin 化）に着手する際、上表の「汎用」列をそのままプラグイン本体、「固有」列を
  リポジトリ側設定として切り出す
