# SPEC 07: Claude Code 側にしかない hook を、Codex へ持っていく

- feature: `codex-hook-parity-07-claude-only-hooks`
- baseCommit: `42560411`
- 重要度: 中 / 影響: Codex のみ（Claude Code 側の動きは変えない）
- 状態: 2026-09-30 承認（決めてほしいこと 6 件は、おすすめの通り）。区分 A の 13 個から実装する。A' は実機確認の後、B は 1 つずつ別の仕様書

---

# Part 1 — 仕様（★人間がレビューする部分）

## 何ができるようになるか

Codex で作業しているときにも、Claude Code と同じ「気づき」が出るようになります。

いまは、同じ人が同じリポジトリを触っていても、Claude Code では 47 個の見張りが動き、Codex では 8 個しか動いていません。差の 40 個のうち、**Codex へ持っていけるものを持っていきます**。

仕様書 01〜06 は「壊れていたものを直す」作業でした。今回は「新しく足す」作業です。

## 調べた結果: 40 個の仕分け

| 区分 | 個数 | 内容 | 持っていくか |
| --- | --- | --- | --- |
| A | 13 | リポジトリの状態を見るもの。どのツールから動かしても同じ結果になる | 登録するだけで動く |
| A' | 2 | ローカル Supabase の自動停止（2 個で 1 組） | 登録するだけで動く見込み。ただし Codex が「セッションの終わり」を知らせてくれるかの確認が先 |
| B | 7 | 考え方は持っていけるが、Codex 向けに作り直しが要るもの | 作り直す（1 つずつ別の仕様書にする） |
| C1 | 7 | 見張る対象が Claude Code そのもの | 持っていかない |
| C2 | 10 | AIDD のワークフロー（Claude Code の機能で動く）を見張るもの | 持っていかない |
| C3 | 1 | Codex では別の仕組みで既に守られているもの | 持っていかない |

合計 40 個（A 13 + A' 2 + B 7 + C1 7 + C2 10 + C3 1）。

### A: 登録するだけで動くもの（13 個）

すべて「セッションの始まりに 1 回見て、問題があれば知らせるだけ」です。作業は止めません。

| # | 何を知らせるか |
| --- | --- |
| 1 | git の hook が動いていない（設定が壊れている） |
| 2 | 長く止まったままの課題（`blocked` の印が付いて 90 日以上） |
| 3 | 守りの訓練（四半期ごと）の期限切れ |
| 4 | 公式ドキュメントの差分確認の期限切れ |
| 5 | 依存パッケージの棚卸しの期限切れ |
| 6 | 鍵・権限の棚卸しの期限切れ |
| 7 | 用済みの作業場所やブランチが溜まっている |
| 8 | 中身が空のセッション記録が残っている |
| 9 | 統合テストを、最後に通してから変更が入っている |
| 10 | E2E テストを、最後に通してから変更が入っている |
| 11 | 認可のテストの効き目を、最後に測ってから変更が入っている |
| 12 | テスト全体の効き目を、最後に測ってから変更が入っている |
| 13 | 見張りそのものが、この環境で動く条件を満たしていない |

### A': ローカル Supabase の自動停止（2 個）

| # | 何をするか |
| --- | --- |
| 14 | `supabase start` の直前に、「このセッションが起動した」という印を残す |
| 15 | セッションが終わるとき、印があれば `supabase stop` する |

Codex が「セッションの終わり」を hook に知らせてくれない場合、15 番は動きません。その場合は 14 番も意味が無いので、**2 個とも持っていきません**。

### B: 作り直しが要るもの（7 個）

| # | 何をするものか | なぜそのまま持っていけないか |
| --- | --- | --- |
| 16 | 落ちたテストを拾って下書きにする | Codex は、コマンドが失敗したかどうか（終了コード）を hook に渡してくれない。出力の文字から読み取る作りに変える必要がある |
| 17 | 下書きがあるのに台帳を触っていないとき、聞く | 16 番が動かないと、聞く材料が無い |
| 18 | 全体のテストを通さずに終えようとしたら知らせる | 「このセッションで 1 回だけ知らせた」の記録を、Claude Code と別の場所に置く必要がある |
| 19 | 重要な領域を触ったのに、設計の記録を足していないとき促す | 同上 |
| 20 | PR の本文が引き継ぎの形になっていないとき知らせる | Claude Code の会話の記録を読んで「PR を作ったか」を判断している。Codex の記録は形が違い、安定もしていない |
| 21 | 直前の発言の内容を、実際の変更と突き合わせる | 同上。さらに、突き合わせに Claude を呼んでいる |
| 22 | 重要な領域を、事前の判定を通さずに編集しようとしたら知らせる | Codex のファイル編集の形に合わせる必要がある（仕様書 01 と同じ話）。止めずに知らせる、が Codex でできるかも未確認 |

### C: 持っていかないもの（18 個）

| 区分 | 個数 | 例 | 理由 |
| --- | --- | --- | --- |
| C1 | 7 | Claude Code の設定の点検、`CLAUDE.md` の大きさの点検、Claude Code のプラグインの点検 | 見張る対象が Claude Code の中にあり、Codex には同じものが無い |
| C2 | 10 | ワークフローの記録漏れの点検、ワークフローが途中で止まったときの検知 | AIDD のワークフローは Claude Code の機能で動いている。Codex では回していないので、見張るものが無い |
| C3 | 1 | 読み取り専用の役割が、コマンドで書き込むのを止める | Codex では、役割ごとの設定（`sandbox_mode = "read-only"`）で既に止めている |

## 操作の流れ（変更後）

| 場面 | いま（Codex） | 変更後（Codex） |
| --- | --- | --- |
| セッションの始まり | 3 個の見張りが動く | 16 個の見張りが動く（A の 13 個が増える） |
| `supabase start` を実行 | 何も起きない | 印を残す（A' を入れた場合） |
| セッションの終わり | 何も起きない | 自分が起動した Supabase を止める（A' を入れた場合） |
| Claude Code での作業 | 変わらない | 変わらない |

## 受け入れ条件

- [ ] A の 13 個が、Codex のセッションの始まりに動き、Claude Code と同じ文言で知らせる
- [ ] 問題が無いときは、何も出ない（13 個が増えても、静かなセッションは静かなまま）
- [ ] セッションの始まりが、体感で遅くならない（上限は下の「決めてほしいこと」5 番）
- [ ] Claude Code 側の 47 個は、1 個も変わらない
- [ ] A' は、Codex が「セッションの終わり」を知らせてくれることを実機で確認してから入れる。知らせてくれない場合は入れず、既知の制約に書く
- [ ] Codex の実機で、A のうち最低 3 個が実際に知らせることを確認し、記録に残す
- [ ] 「Claude Code にあって Codex に無い見張り」の一覧を文書に残し、増減したら検査が気づく

## 決めてほしいこと

| # | 決めること | おすすめ | 理由 |
| --- | --- | --- | --- |
| 1 | **どこまでやるか** | A と A' の 15 個まで。B の 7 個は、1 つずつ別の仕様書にして、必要になったものから | A は登録だけで済む。B は 1 個ずつが新しい開発で、まとめて約束すると終わりが見えなくなる |
| 2 | **vkumai だけに入れるか、プラグインでも配るか** | まず vkumai だけ | A の多くは vkumai の運用文書（訓練や棚卸しの予定日）を読む。導入先にはその文書が無い。配るかは、導入先が決まってから |
| 3 | **Codex での登録のしかた** | 入口を 1 個にまとめ、その中で 13 個を順に動かす | Codex は hook を 1 個ずつ人が信頼する必要がある。13 個を個別に登録すると 13 回の操作が要り、1 個足すたびに信頼し直しになる。入口を 1 個にすれば、信頼は 1 回で済む |
| 4 | 上の 3 番にすると、**後から見張りを足しても、信頼の確認が出ない**。これでよいか | はい | Codex の信頼は「登録の内容」を見ていて、スクリプトの中身は元から見ていない（0.1.4 の配布で実測）。入口を分けても分けなくても、中身の変更は確認されない |
| 5 | セッションの始まりに掛けてよい時間の上限 | 合計 5 秒 | Claude Code 側は 24 個を動かしている。GitHub へ問い合わせるものが 2 個あり、通信が遅いと伸びる。上限を超えたら、残りは飛ばして「飛ばした」と知らせる |
| 6 | AIDD のワークフローを、今後 Codex でも回す予定はあるか | 無い、として進める | 予定があるなら、C2 の 10 個は「持っていかない」ではなく「ワークフローを移すときに一緒に考える」になる |

## 先にお伝えしておきたいこと

- **これは見張りを増やす作業で、製品（医療材料の在庫管理）は 1 行も変わりません。** 以前に「ハーネスの作業はここで止め、次は導入先を決める」と決めた方針とは、向きが逆です。ご指示をいただいたので仕様書にしましたが、進めるかどうかは、この点も含めてご判断ください
- A の 13 個は、同じ人が Claude Code で作業すれば既に出ている知らせです。Codex でも出す価値は、「Codex だけで作業する日がどれくらいあるか」で決まります
- 40 個という数は、前回お伝えした「14 個」より多くなりました。前回は、セッションの始まりの見張りなどを数えていませんでした

## 分かっていないこと

- Codex CLI 0.147.0 が「セッションの終わり」を hook に知らせるか（公式の説明には載っている。実機では未確認）
- Codex の、ファイルを編集する前の hook で、「止めずに知らせる」ができるか
- 13 個を動かしたときの、実際の所要時間

---

# Part 2 — 実装計画（AI 用・レビュー不要）

## 根拠（2026-09-29 実測）

### 数

`.claude/settings.json` の hook は 47 件、`.codex/hooks.json` は 8 件。Codex 側に同じもの・相方があるのは 7 件（`check-direct-ddl-execution.sh` / `check-skip-marker-write.sh` / `check-dependency-change.sh` / `ai-check-suggest.sh` / `check-branch-pr-status.sh` / `check-branch-tool-ownership.sh` / `check-local-main-freshness.sh`）。Claude 側にしか無いのは 47 − 7 = 40 件（スクリプトは 39 本。`log-subagent-hook-skeleton.sh` が 2 つのイベントに登録されている）。

### 区分ごとのスクリプト

| 区分 | スクリプト |
| --- | --- |
| A（13） | `check-hooks-path-alive.sh` / `check-blocked-issues-staleness.sh` / `check-fault-injection-drill-staleness.sh` / `check-upstream-docs-review-staleness.sh` / `check-dependency-update-staleness.sh` / `check-access-review-staleness.sh` / `check-stale-worktrees.sh` / `check-empty-session-report.sh` / `check-integration-freshness.sh` / `check-e2e-freshness.sh` / `check-rls-mutation-freshness.sh` / `check-mutation-freshness.sh` / `check-hook-dependencies.sh` |
| A'（2） | `mark-supabase-started.sh`（PreToolUse）/ `stop-supabase-on-session-end.sh`（SessionEnd） |
| B（7） | `record-test-failure.sh` / `check-escape-ledger.sh` / `check-full-run-before-finish.sh` / `check-domain-decisions-suggest.sh` / `check-handoff-format.sh` / `verify-claims.sh` / `check-run-manifest-presence.sh` |
| C1（7） | `check-automode-config.sh` / `check-claude-md-size.sh` / `check-subagent-model-force.sh` / `check-otel-collector-status.sh` / `check-plugin-integrity.sh` / `maintenance-digest.sh`（Setup）/ `log-instructions-loaded.sh`（InstructionsLoaded） |
| C2（10） | `check-workflow-interruption.sh` / `check-recovery-queue.sh` / `reinject-aidd-run-state.sh` / `gate-effectiveness-monthly-check.sh` / `check-gap-check-state.sh` / `check-aidd-stats-recorded.sh` / `check-aidd-phase-stats-recorded.sh` / `check-find-av-precision-recorded.sh` / `log-subagent-hook-skeleton.sh`（SubagentStart）/ 同（SubagentStop） |
| C3（1） | `check-readonly-bash.sh` |

### Codex が hook に渡す入力（CLI 0.147.0、信頼済みの hook を記録用に一時差し替えて実測）

| イベント | 最上位のキー | 分かったこと |
| --- | --- | --- |
| SessionStart | `cwd` / `hook_event_name` / `model` / `permission_mode` / `session_id` / `source` / `transcript_path` | `source` は `startup`。Claude と同じ名前 |
| PostToolUse（Bash） | 上に加えて `tool_input` / `tool_name` / `tool_response` / `tool_use_id` / `turn_id` | **`tool_response` は文字列**（コマンドの出力そのもの）。`false` を実行させたときの値は空文字で、**終了コードは入っていない**。Claude は構造体で渡す |
| Stop | 上に加えて `last_assistant_message` / `stop_hook_active` / `turn_id` | 直前の発言が文字列で入る。会話の記録を読まなくても、直前の発言は取れる |

`transcript_path` は渡されるが、公式ドキュメントは「形式は安定したインターフェースではない」としている（共存の原則 7 と一致）。

### A の各スクリプトの根の決め方

13 本とも `${CLAUDE_PROJECT_DIR:-<スクリプトの位置から決める>}` か git の問い合わせで根を決めており、`CLAUDE_PROJECT_DIR` が無くても動く。project hook として `"$(git rev-parse --show-toplevel)"/scripts/<名前>` で呼べば、根は正しく決まる。出力は `systemMessage` と `hookSpecificOutput.additionalContext`（`hookEventName: "SessionStart"`）で、既に Codex で動いている 3 本と同じ形。

## 実装セット（決めてほしいこと 1〜3 がおすすめ通りの場合）

| セット | 触るファイル | 内容 |
| --- | --- | --- |
| A | `scripts/codex-session-start.sh`（新規）/ `scripts/codex-session-start.test.sh`（新規） | 入口。一覧に載っているスクリプトを順に動かし、出力をまとめて 1 つの JSON にする |
| B | `scripts/lib/codex-session-start-checks.txt`（新規） | 動かすスクリプトの一覧（13 本）。1 行 1 本 |
| C | `.codex/hooks.json` | SessionStart に入口を 1 件足す |
| D | `scripts/codex-config-separation.test.sh` | 「Claude にあって Codex に無いもの」の一覧と、その理由（区分）を固定する。増減したら落ちる |
| 統合 | `docs/agents/file-index.md` / `scripts/lib/harness-registry.json` / `docs/agents/harness-map.md` / `scripts/lib/plugin-layout.json`（配らない宣言） | 登録簿と地図 |

A・B は新規ファイルで、ほかと重ならない。C・D・統合は既存ファイルなので順に行う。

## 方針

- 入口は、各スクリプトへ同じ標準入力を渡し、`systemMessage` を改行で繋ぐ。1 本が失敗しても残りは動かす（警告だけの hook は失敗しない。仕様書 05 と同じ考え方）
- 合計時間の上限を超えたら、残りを飛ばして「時間切れで N 本を飛ばした」と知らせる。黙って飛ばさない
- 一覧に無いスクリプトは動かさない。一覧の各行が実在して実行できることを、テストで見る
- 既存の 3 本（`check-branch-pr-status.sh` など）は、`hooks.json` の登録を変えない（変えると信頼し直しになる）
- A' は、SessionEnd の実機確認の結果が出てから、別のコミットで足す
- 状態ファイルを持つスクリプトは A に入れていない（共存の原則 7）。A の 13 本が書き込むのは、鮮度の記録（`logs/`）を読むだけで、書かない

## テスト観点

- 一覧の 13 本が、実在して実行できる
- 入口が、各スクリプトの出力を欠けずにまとめる（1 本だけ知らせる・複数が知らせる・全部黙る）
- 1 本が失敗（exit 1・JSON でない出力）しても、入口は exit 0 で、残りの出力は出る
- 時間切れのとき、飛ばした本数を知らせる
- `jq` が無いとき、入口は黙って exit 0（警告だけの hook の方針）
- 壊して落ちる: 一覧から 1 本消す → 「Claude にあって Codex に無いもの」の検査が落ちる

## 実機確認（承認後、実装の前に行うもの）

| 確認 | やり方 | 分かること |
| --- | --- | --- |
| SessionEnd が来るか | 検証用 clone の project hook に、記録だけの SessionEnd を 1 件足して、人が `/hooks` で信頼し、セッションを終える | A' を入れられるか |
| PreToolUse で「止めずに知らせる」ができるか | 同じく、`permissionDecision: "allow"` + `additionalContext` を返す hook を足す | B の 22 番の作り方 |

どちらも hook の登録を足すので、**人による信頼の操作が要る**。

---

# Part 3 — セルフチェック（AI 用・レビュー不要）

- UI 変更: なし
- 新しい値: 区分 6 種（A / A' / B / C1 / C2 / C3）。判定基準は Part 1 の表の「内容」列。下流は「持っていくか」列で、A = 登録、A' = 実機確認の後に登録、B = 別の仕様書、C1〜C3 = 持っていかない
- 列挙: 40 = 13 + 2 + 7 + 7 + 10 + 1。Part 1 の A の表は 13 行、A' は 2 行、B は 7 行（通し番号 1〜22）。C は区分ごとの個数のみ（7 + 10 + 1 = 18）。Part 2 のスクリプトの表の本数と一致
- 信号の意味: Claude 側の登録・スクリプトは変えない。Codex 側は SessionStart の出力が 1 件増える（既存の 3 件は変えない）
