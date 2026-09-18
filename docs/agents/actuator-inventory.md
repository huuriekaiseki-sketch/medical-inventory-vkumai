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
| PreToolUse (Bash、`agent_type` が読み取り専用ロールのときのみ) | `check-readonly-bash.sh` | **deny** | sweep-ui / sweep-data / sweep-db / sweep-types / reviewer / completeness-critic / adversarial-verify / judge-panel のサブエージェント内で、許可リスト外の Bash（リダイレクト・`sed -i`・`rm`・`git checkout`・`node -e` 等）を拒否する（issue #713）。subagent frontmatter の `hooks:` は実機で効かなかったため settings.json 側に置く。agentType 経由で呼ばれた場合のみ `agent_type` が入るため、aidd-1-1-deep-task.js のインライン指定ロールには効かない |
| PreToolUse (Write/Edit/MultiEdit skipマーカー) | `check-skip-marker-write.sh` | **ask** | verify-claimsのエスケープハッチ書き込みに人間確認を要求 |
| PreToolUse (Bash/Write/Edit/MultiEdit 依存変更) | `check-dependency-change.sh` | **ask** | `npm install <pkg>` / `yarn add` / `pnpm add` 等のパッケージ名を伴う依存変更コマンドと、package.json / package-lock.json への書き込みに人間確認を要求（2026-09-04。依存追加は第三者コードを増やす設計判断として、用途・代替案・影響の報告を挟む）。`npm ci` / 引数なしの `npm install` / 読み取り系は対象外。jq 不在時は fail-closed |
| PreToolUse (Codex側・Bash/Write/Edit/MultiEdit 依存変更) | `codex-dependency-change-deny.sh` | **deny**（Codex側のみ） | `check-dependency-change.sh`（Claude側ask）のCodex用ラッパー。ask未対応のためdenyへ読み替え、判定は共有正本に委譲 |
| PreToolUse (Write/Edit/MultiEdit 高リスクパス) | `check-run-manifest-presence.sh` | warning-only | `permissionDecision: "allow"` + `additionalContext`。blockしない設計（issue #444、意図的） |
| SessionStart | `check-workflow-interruption.sh` | **自動復旧（queue）** | Workflow中断を検知し`workflow-interrupted`としてqueue登録（issue #534） |
| SessionStart | `check-recovery-queue.sh` | 自動復旧（queue、表示側） | pendingエントリのcontext注入＋surfaced放置エントリのエスカレーション表示（issue #523・#579）。是正の実行そのものはこのhookの範囲外 |
| SessionStart（matcher: `compact` のみ） | `reinject-aidd-run-state.sh` | context 注入（是正なし） | compaction 直後に `.aidd/run-manifest.json`・`logs/agent-progress.jsonl`・`.aidd/recovery-queue.jsonl` の現在値を additionalContext として再注入する（issue #712）。同時に startup 群の警告系 hook（導入時 12 本、2026-09-05 時点で 14 本）は matcher `startup\|resume\|clear\|fork` に限定し、compact 時には再実行しない。構成は `scripts/check-session-start-matchers.test.sh` が固定する |
| SessionStart | `check-branch-pr-status.sh` | warning-only | マージ済みブランチ上での作業を警告 |
| SessionStart | `check-branch-tool-ownership.sh` | warning-only | ブランチ命名規約（codex/*・claude/*）と起動ツールの取り違えを警告。Claude/Codex両方のhook設定に登録される共有ガード（引数で自ツール名を渡す）。block不可のSessionStartのため意図的にwarning-only |
| PreToolUse (Codex側・Bash/Write/Edit skipマーカー) | `codex-skip-marker-deny.sh` | **deny**（Codex側のみ） | `check-skip-marker-write.sh`（Claude側ask）のCodex用ラッパー。Codexはask未対応（実機確認済み）のためdenyへ読み替える。判定ロジックは共有正本に委譲し、出力契約の変換のみ担う |
| SessionStart | `check-local-main-freshness.sh` | warning-only | ローカルmain鮮度の警告 |
| SessionStart | `check-hooks-path-alive.sh` | warning-only | **git hook 自体が動いているか**の警告（issue #779 / E-092）。`core.hooksPath` が実在しないディレクトリを指すと git は黙って無視し、commit-msg も pre-push も動かない。worktree スコープの上書きも知らせる。**この検知を git hook で実装すると、検知したい故障と一緒に死ぬ**ので SessionStart に置く |
| SessionStart | `check-otel-collector-status.sh` | warning-only | OTel collector状態の情報提示 |
| SessionStart | `check-automode-config.sh` | warning-only | autoMode(hard_deny)未設定の警告（個人設定のため機械強制不可） |
| SessionStart | `check-blocked-issues-staleness.sh` | warning-only | `blocked`ラベル長期滞留issueの警告 |
| SessionStart | `check-fault-injection-drill-staleness.sh` | warning-only | fault injection訓練の実施タイミング警告 |
| SessionStart | `check-upstream-docs-review-staleness.sh` | warning-only | 公式ドキュメント差分の定期確認（`docs/agents/upstream-docs-review.md`）の期限切れ警告 |
| SessionStart | `check-dependency-update-staleness.sh` | warning-only | 依存の月次棚卸し（`docs/agents/dependency-update-runbook.md`、issue #757 の 21）の期限切れ警告。Dependabot は major を判断しないため人の棚卸しを定期化する |
| SessionStart | `check-access-review-staleness.sh` | warning-only | 鍵・権限・token の四半期棚卸し（`docs/agents/access-review-runbook.md`、issue #757 の 36）の期限切れ警告。未使用の公開 RPC・admin 利用者・ADMIN_EMAILS・token の scope と期限・SSH 鍵 |
| SessionStart | `check-subagent-model-force.sh` | warning-only | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`（Claude Code 2.1.257）が環境変数または settings の `env` に非空であれば警告（issue #743）。全 subagent のモデルを強制するため AIDD のモデル階層（agent ごとの model 指定、issue #419・#693）が黙って無効化される。個人環境の変数はリポジトリから消せず、意図的に使う場面もあるため warning-only |
| Setup（matcher `maintenance`） | `maintenance-digest.sh` | warning-only | `claude -p --maintenance` で fault-injection 訓練・hook 実走ドリル・docs 差分確認・依存の月次棚卸し・鍵と権限の四半期棚卸しの 5 期限を一括表示（issue #741、#757 の 21・36）。明示的に呼ばないと動かないため SessionStart の個別警告は残す |
| SessionStart | `check-plugin-integrity.sh` | warning-only | 配布物の同一性（issue #757 の 37）。build-plugin.sh が各プラグインに書く `.aidd-manifest.json`（全ファイルの sha256）と実物を突き合わせ、差し替え・欠落・混入を警告する。中心リポジトリでは `dist/plugins/*`、導入先では `$CLAUDE_PLUGIN_ROOT` を見る。manifest ごと書き換えられたら検知できない（署名は #757-30）ため、止める力は持たせず warning-only |
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
| Stop | `check-find-av-precision-recorded.sh` | warning-only | find-av-precisionログ記録漏れの警告（issue #522） |
| Stop | `check-full-run-before-finish.sh` | warning-only | **いまの状態で統合テスト・E2E の全件を通したか**を終える瞬間に聞く（C-041 の機械化、2026-09-09）。判定は SessionStart 側と同じ engine（`lib/run-freshness.py`）だが、見る材料を HEAD の木から**未コミット・未追跡を含む「いまの姿」のハッシュ**へ広げた（`lib/worktree-hash.sh`）。手元で書き換えて単体だけ緑にして終える形は HEAD の木では見えない。セッションに 1 回だけ鳴る（毎ターン鳴ると読まれなくなる。C-031）。block しない（DB を落としている・時間が無い、は普通にある） |
| （参考）`pull_request`（高リスクパス限定） | `.github/workflows/integration-gate.yml` | **block**（PRチェック失敗。ただしFreeプランのためマージは阻止されない） | `supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/middleware.ts`・`**/proxy.ts` に触れたPRでのみ `npm run test:integration` を実行する。従来 `e2e.yml` は `push:[main]` のみで、**壊れたRLS変更をマージ前に止められなかった**（mainへ入った後で初めて鳴る）。全PRで回すとActions無料枠が枯渇するため（2026-08の実績）、パスで絞った。**既知の限界**: `paths`はファイルパスしか見られないため、TRI/RISK基準のうち内容ベースの判定（auth/facility/tenant等のドメイン）は表現できず、そこは引き続き`.claude/rules/db-schema.md`のローカル実行義務に依存する |
| （参考）`npm test`（CI含む） | `supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts` | **block**（テスト失敗、ただしCI上の強制力はプラン依存） | issue #675。カーディナリティ未宣言の後付けFK列・統合テスト対応の無い制約migrationの**新規発生**を止める（既知分はbaselineに固定するratchet方式）。hookではなくテストなので、ローカル`npm test`とCIの両方で機械的に起動する。ただし本リポジトリはFreeプランでCI失敗がマージを阻止しないため、実効的な強制力はローカル実行時に限る |
| SessionStart | `check-empty-session-report.sh` | warning-only | 空のセッションレポート（`docs/sessions/` の自動生成テンプレが中身のまま残っているもの）を警告。**2026-09-12 に表へ追加**（下記の「表の抜け」参照） |
| SessionStart | `check-hook-dependencies.sh` | warning-only | この環境で検知 hook が実際に動くか（jq / node / python3 / npx の有無）を毎セッション知らせる（issue #757 の 37 の周辺）。走査の本体は `scripts/lib/aidd-doctor.mjs` で、依存は**スクリプトの実体から実測する**（宣言表を持たない）。node が無ければ「hook の生存診断ができません＝検知 hook が動いているかは誰も見ていない状態です」と言う。**2026-09-12 に表へ追加** |
| SessionStart | `check-integration-freshness.sh` | warning-only | 統合テストの打ち忘れ（木が変わったのに測っていない）を警告。H-02 / H-05 の「人が打つが打ち忘れは機械が拾う」の実体。**2026-09-12 に表へ追加** |
| SessionStart | `check-e2e-freshness.sh` | warning-only | E2E の打ち忘れを警告。同上。**2026-09-12 に表へ追加** |
| SessionStart | `check-rls-mutation-freshness.sh` | warning-only | RLS 変異計測の打ち忘れを警告。H-06 の「打ち忘れは SessionStart hook が拾う」の実体。**2026-09-12 に表へ追加** |
| SessionStart | `check-mutation-freshness.sh` | warning-only | 製品コードの変異計測（Stryker）の打ち忘れを警告。測る対象の一覧も見張る（対象を減らせばスコアは上がるため）。**2026-09-12 に表へ追加** |
| Stop | `check-escape-ledger.sh` | warning-only | 落ちた検査の下書きがあるのに `escaped-defects.md` を触っていなければ聞く。台帳へ移す一歩そのものは止めない（止めると書く側が下書きを消す）。**2026-09-12 に表へ追加** |
| Stop（Codex側） | `codex-ai-check-suggest.sh` | warning-only | Claude 側 `ai-check-suggest.sh` の Codex 版（2026-09-11 に派生先から逆輸入。Codex 側には Stop hook が 1 本も無かった）。同じく止めない。**2026-09-12 に表へ追加——しかもこの 1 本は、人が手で突き合わせたときには見落としており、`check-actuator-inventory-coverage.test.sh` が書いた直後に見つけた**（`.codex/hooks.json` 側の登録を目視で追い切れていなかった） |
| （参考）per-edit | security-guidanceプラグイン（`possible_real_facility_name`等） | warning-only | issue #440。Claude Code公式プラグイン経由、上記`.claude/settings.json`のhooksとは別経路 |

（`SubagentStart`/`SubagentStop`の`log-subagent-hook-skeleton.sh`、および`InstructionsLoaded`の
`log-instructions-loaded.sh`（issue #742。公式仕様で出力が全て無視されるため是正手段を持ちえない）は
検知ではなく記録専用のためこの表の対象外）

## 集計と評価

（**2026-09-12 に数え直した**。それまでの「約23件」は表の抜け **8 件**と deny 2 件を落としていた。
数え方: `.claude/settings.json` の `hooks` に登録された 43 本（`log-subagent-hook-skeleton.sh` の
2 回登録を 1 本と数える）＋ `.codex/hooks.json` の 3 本（deny 2 本と Stop hook 1 本）から、
記録専用の 3 本（`log-subagent-hook-skeleton.sh`・`log-instructions-loaded.sh`・
`record-test-failure.sh`）を除く。
**この数え方は `scripts/check-actuator-inventory-coverage.test.sh` が毎回実測する**ので、
ここの数字が古くなったら検査が落ちる——**人が手で数えた 1 回目は 8 本目を見落としていた**）

- block: 3件（うち1件はretry上限付きエスケープあり。`check-readonly-bash.sh` は読み取り専用ロールのサブエージェント内のみ、issue #713）
- ask: 1件
- **deny: 2件**（Codex 側のみ。`codex-skip-marker-deny.sh`・`codex-dependency-change-deny.sh`。
  Codex は ask 未対応のため Claude 側の ask を deny へ読み替える。**2026-09-12 まで集計に無かった**）
- 自動復旧（queue、うち登録側）: 2件（`check-workflow-interruption.sh`・`check-gap-check-state.sh`）
- 自動復旧（queue、表示側）: 1件（`check-recovery-queue.sh`）
- warning-only: 25件
- context 注入（是正なし、compact 時のみ）: 1件（`reinject-aidd-run-state.sh`、issue #712）

**31件**の検知hookのうち、機械的に実行を止める・確認を強制する（block/ask/deny）のは6件。
recovery-queue接続によって「次回セッション冒頭で機械的に目の前に出る」までは自動化されている
ものが3件。残る25件はすべて、systemMessageが出力された後の是正判断・実行タイミングを完全に
人（またはそれを読んだセッション）に委ねている。

（2026-08-10訂正: `verify-claims.sh`は当初この表でwarning-onlyと誤記されていたが、実装は
`emit_block`による`exit 2`のblockだった。棚卸し文書自体が実装とドリフトし得るという実例。
cardiosearch側issue #5でこの種の乖離を機械検知する仕組みを導入済み、本リポジトリへの
逆輸入は未着手）

（**2026-09-12 訂正: 同じドリフトが 2 例目として、しかも桁違いの規模で起きていた。**
`.claude/settings.json` の `hooks` に登録され実際に動いているのに、この表に 1 行も無い検知 hook が
**7 本**あった——`check-empty-session-report.sh`・`check-hook-dependencies.sh`・
`check-integration-freshness.sh`・`check-e2e-freshness.sh`・`check-rls-mutation-freshness.sh`・
`check-mutation-freshness.sh`・`check-escape-ledger.sh`。7 本とも `systemMessage` を出す検知 hook で、
記録専用の対象外規定には当たらない。加えて集計には **deny の行そのものが無く**、Codex 側 2 件も
落ちていた。とくに重いのは**鮮度 hook 4 本**——ハーネスの地図が H-02 / H-05 / H-06 の
「人が打つが**打ち忘れは機械が拾う**」という中核の担保として説明している hook 群が、
是正の棚卸しから丸ごと漏れていた。読む人は「打ち忘れ検知は止めるのか警告だけなのか」を
この表から判断できない状態だった。
**1 例目の訂正のときに「逆輸入は未着手」と書いたまま着手しなかったのが、そのまま 2 例目を招いた**
——「機械で突き合わせない宣言は必ずずれる」ことの、この文書自身による実証になっている）

**この偏り自体は問題ではない。** 停止①②（仕様レビュー・構造化レビュー）はそもそも人間判断が
本質であり、機械化すべきでない。また`check-otel-collector-status.sh`のような情報提示や、
`check-automode-config.sh`のような個人設定変更を伴うものは、原理的にblock/queue化できない
（個人の`~/.claude/settings.json`をプロジェクト側から強制する手段が無い、issue #439）。

**次に見るべき問い（この棚卸しの使い方）:** 表の各warning-only行について、「意図的に
warning-onlyにしている（人間判断が本質・機械強制できない対象）」のか「単にrecovery-queue接続を
まだやっていないだけ」なのかを個別に判断すること。後者に該当する候補（例:
`check-aidd-stats-recorded.sh`・`check-aidd-phase-stats-recorded.sh`のような、対応内容が
定型的で自律対応しやすいもの）があれば、queue接続の追加候補としてissue化する。
