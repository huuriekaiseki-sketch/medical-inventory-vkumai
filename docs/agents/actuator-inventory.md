# 検知ループのアクチュエータ側棚卸し（issue #578）

[`undetectable-rules-inventory.md`](./undetectable-rules-inventory.md)がセンサー（検知手段が
「無い」ルール）の棚卸しであるのに対し、本ファイルは**センサーが「ある」検知hook約20件について、
検知後に誰が是正するか（アクチュエータ）**を棚卸しする。原則の背景は
[`decisions.md`の該当原則](./decisions.md#なぜ新しい検知メカニズムにアクチュエータ検知後に誰が直すかも先に決める原則を追加したかissue-578)を参照。

新しい検知hookを追加・変更したら、この表に行を追加/更新すること。

## 分類基準

| 分類 | 意味 |
|---|---|
| block | ツール実行自体を機械的に拒否する（`permissionDecision: "deny"`） |
| ask | ツール実行前に人間の明示的確認を要求する（`permissionDecision: "ask"`） |
| 自動復旧（queue） | `scripts/queue-recovery-task.sh`で`.aidd/recovery-queue.jsonl`へ登録し、次回セッション冒頭で機械的に目の前へ出す。実際の是正はセッション自身が自律的に行うか、人が対応後`scripts/resolve-recovery-task.sh`で閉じる（issue #523・#579） |
| warning-only | `systemMessage`/`additionalContext`を出すのみ。是正するかどうか・いつ是正するかは完全に人（またはそれを読んだセッション）の裁量に委ねられ、機械的な強制力は無い |

## 棚卸し表

| Hookイベント | スクリプト | 分類 | 備考 |
|---|---|---|---|
| PreToolUse (Bash/mcp DDL) | `check-direct-ddl-execution.sh` | **block** | 直接DDL実行を拒否 |
| PreToolUse (Write/Edit/MultiEdit skipマーカー) | `check-skip-marker-write.sh` | **ask** | verify-claimsのエスケープハッチ書き込みに人間確認を要求 |
| PreToolUse (Bash/Write/Edit/MultiEdit 依存変更) | `check-dependency-change.sh` | **ask** | `npm install <pkg>` / `yarn add` / `pnpm add` 等のパッケージ名を伴う依存変更コマンドと、package.json / package-lock.json への書き込みに人間確認を要求（2026-09-04。依存追加は第三者コードを増やす設計判断として、用途・代替案・影響の報告を挟む）。`npm ci` / 引数なしの `npm install` / 読み取り系は対象外。jq 不在時は fail-closed |
| PreToolUse (Codex側・Bash/Write/Edit/MultiEdit 依存変更) | `codex-dependency-change-deny.sh` | **deny**（Codex側のみ） | `check-dependency-change.sh`（Claude側ask）のCodex用ラッパー。ask未対応のためdenyへ読み替え、判定は共有正本に委譲 |
| PreToolUse (Write/Edit/MultiEdit 高リスクパス) | `check-run-manifest-presence.sh` | warning-only | `permissionDecision: "allow"` + `additionalContext`。blockしない設計（issue #444、意図的） |
| SessionStart | `check-workflow-interruption.sh` | **自動復旧（queue）** | Workflow中断を検知し`workflow-interrupted`としてqueue登録（issue #534） |
| SessionStart | `check-recovery-queue.sh` | 自動復旧（queue、表示側） | pendingエントリのcontext注入＋surfaced放置エントリのエスカレーション表示（issue #523・#579）。是正の実行そのものはこのhookの範囲外 |
| SessionStart（matcher: `compact` のみ） | `reinject-aidd-run-state.sh` | context 注入（是正なし） | compaction 直後に `.aidd/run-manifest.json`・`logs/agent-progress.jsonl`・`.aidd/recovery-queue.jsonl` の現在値を additionalContext として再注入する（issue #712）。同時に上記 12 本の警告系 hook は matcher `startup\|resume\|clear\|fork` に限定し、compact 時には再実行しない。構成は `scripts/check-session-start-matchers.test.sh` が固定する |
| SessionStart | `check-branch-pr-status.sh` | warning-only | マージ済みブランチ上での作業を警告 |
| SessionStart | `check-branch-tool-ownership.sh` | warning-only | ブランチ命名規約（codex/*・claude/*）と起動ツールの取り違えを警告。Claude/Codex両方のhook設定に登録される共有ガード（引数で自ツール名を渡す）。block不可のSessionStartのため意図的にwarning-only |
| PreToolUse (Codex側・Bash/Write/Edit skipマーカー) | `codex-skip-marker-deny.sh` | **deny**（Codex側のみ） | `check-skip-marker-write.sh`（Claude側ask）のCodex用ラッパー。Codexはask未対応（実機確認済み）のためdenyへ読み替える。判定ロジックは共有正本に委譲し、出力契約の変換のみ担う |
| SessionStart | `check-local-main-freshness.sh` | warning-only | ローカルmain鮮度の警告 |
| SessionStart | `check-otel-collector-status.sh` | warning-only | OTel collector状態の情報提示 |
| SessionStart | `check-automode-config.sh` | warning-only | autoMode(hard_deny)未設定の警告（個人設定のため機械強制不可） |
| SessionStart | `check-blocked-issues-staleness.sh` | warning-only | `blocked`ラベル長期滞留issueの警告 |
| SessionStart | `check-fault-injection-drill-staleness.sh` | warning-only | fault injection訓練の実施タイミング警告 |
| SessionStart | `check-claude-md-size.sh` | warning-only | CLAUDE.md/docs/agents/common.mdの行数肥大化を警告（トークン効率化。common.mdは機械検知ルール集のため「短ければ良い」わけではなく、削除判断は人間に委ねる） |
| SessionStart | `check-stale-worktrees.sh` | warning-only | worktree・ローカルブランチ残骸の蓄積警告（issue #674）。マージ/クローズ済みPRに対応するworktree数・goneブランチ数（閾値超過時）・PRを一度も作らず一定日数放置されたブランチ数（閾値超過時、issue #708）を警告。削除は不可逆に近い操作のため意図的にwarning-only |
| Stop | `check-gap-check-state.sh` | **自動復旧（queue）** | gap check警告を`gap-check-followup`としてqueue登録（issue #488・#523） |
| Stop | `check-domain-decisions-suggest.sh` | warning-only | 高リスクドメイン変更時のドキュメント反映漏れ提案。**issue #685でagent型からcommand型へ置き換えた**（agent版は抑止条件に該当する場面でも毎ターンサブエージェントを起動し、「何も返さない」指示に反して判定理由を返し続けていた）。重複抑止はマーカーファイルで決定的に行い、「設計判断かどうか」の判断だけをメインループへ委ねる。**これによりagent型hookは0本になった** |
| Stop | `ai-check-suggest.sh` | warning-only | `npm run ai:check`実行有無の警告 |
| Stop | `check-handoff-format.sh` | warning-only | PR本文の引き継ぎフォーマット必須見出し（issue #524）、04表の4値（PR②）、package.json変更PRの「依存の変更」記述（2026-09-04）の欠如を警告。行・ファイルを名指しし、blockしない（blockすると書く側が行を削って合図が消えるため） |
| Stop | `verify-claims.sh` | **block**（retry上限3回のエスケープ付き） | 未解消の指摘があれば`emit_block`で`exit 2`しStopをブロックする。3回試行しても解消しなければ人間介入待ちのメッセージでブロックし続ける |
| Stop | `gate-effectiveness-monthly-check.sh` | warning-only | 品質ゲート月次サマリの提示 |
| Stop | `check-aidd-stats-recorded.sh` | warning-only | AIDD stats `start`呼び忘れの警告（issue #495） |
| Stop | `check-aidd-phase-stats-recorded.sh` | warning-only | AIDD stats phase1/phase2呼び忘れの警告（issue #524） |
| Stop | `check-handoff-format.sh` | warning-only | PR本文の引き継ぎフォーマット必須見出し欠如の警告（issue #524。PR本文経由のみ対象） |
| Stop | `check-find-av-precision-recorded.sh` | warning-only | find-av-precisionログ記録漏れの警告（issue #522） |
| （参考）`pull_request`（高リスクパス限定） | `.github/workflows/integration-gate.yml` | **block**（PRチェック失敗。ただしFreeプランのためマージは阻止されない） | `supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/middleware.ts`・`**/proxy.ts` に触れたPRでのみ `npm run test:integration` を実行する。従来 `e2e.yml` は `push:[main]` のみで、**壊れたRLS変更をマージ前に止められなかった**（mainへ入った後で初めて鳴る）。全PRで回すとActions無料枠が枯渇するため（2026-08の実績）、パスで絞った。**既知の限界**: `paths`はファイルパスしか見られないため、TRI/RISK基準のうち内容ベースの判定（auth/facility/tenant等のドメイン）は表現できず、そこは引き続き`.claude/rules/db-schema.md`のローカル実行義務に依存する |
| （参考）`npm test`（CI含む） | `supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts` | **block**（テスト失敗、ただしCI上の強制力はプラン依存） | issue #675。カーディナリティ未宣言の後付けFK列・統合テスト対応の無い制約migrationの**新規発生**を止める（既知分はbaselineに固定するratchet方式）。hookではなくテストなので、ローカル`npm test`とCIの両方で機械的に起動する。ただし本リポジトリはFreeプランでCI失敗がマージを阻止しないため、実効的な強制力はローカル実行時に限る |
| （参考）per-edit | security-guidanceプラグイン（`possible_real_facility_name`等） | warning-only | issue #440。Claude Code公式プラグイン経由、上記`.claude/settings.json`のhooksとは別経路 |

（`SubagentStart`/`SubagentStop`の`log-subagent-hook-skeleton.sh`は検知ではなく記録専用のため
この表の対象外）

## 集計と評価

- block: 2件（うち1件はretry上限付きエスケープあり）
- ask: 1件
- 自動復旧（queue、うち登録側）: 2件（`check-workflow-interruption.sh`・`check-gap-check-state.sh`）
- 自動復旧（queue、表示側）: 1件（`check-recovery-queue.sh`）
- warning-only: 17件
- context 注入（是正なし、compact 時のみ）: 1件（`reinject-aidd-run-state.sh`、issue #712）

約23件の検知hookのうち、機械的に実行を止める・確認を強制する（block/ask）のは3件。
recovery-queue接続によって「次回セッション冒頭で機械的に目の前に出る」までは自動化されている
ものが3件。残る17件はすべて、systemMessageが出力された後の是正判断・実行タイミングを完全に
人（またはそれを読んだセッション）に委ねている。

（2026-08-10訂正: `verify-claims.sh`は当初この表でwarning-onlyと誤記されていたが、実装は
`emit_block`による`exit 2`のblockだった。棚卸し文書自体が実装とドリフトし得るという実例。
cardiosearch側issue #5でこの種の乖離を機械検知する仕組みを導入済み、本リポジトリへの
逆輸入は未着手）

**この偏り自体は問題ではない。** 停止①②（仕様レビュー・構造化レビュー）はそもそも人間判断が
本質であり、機械化すべきでない。また`check-otel-collector-status.sh`のような情報提示や、
`check-automode-config.sh`のような個人設定変更を伴うものは、原理的にblock/queue化できない
（個人の`~/.claude/settings.json`をプロジェクト側から強制する手段が無い、issue #439）。

**次に見るべき問い（この棚卸しの使い方）:** 表の各warning-only行について、「意図的に
warning-onlyにしている（人間判断が本質・機械強制できない対象）」のか「単にrecovery-queue接続を
まだやっていないだけ」なのかを個別に判断すること。後者に該当する候補（例:
`check-aidd-stats-recorded.sh`・`check-aidd-phase-stats-recorded.sh`のような、対応内容が
定型的で自律対応しやすいもの）があれば、queue接続の追加候補としてissue化する。
