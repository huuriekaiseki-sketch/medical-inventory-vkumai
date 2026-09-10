# どこに何があるか（file-index）

このリポジトリの重要なファイル・スクリプトと、その目的の一覧。

**これはルールではなく索引。** 何かを作る前に「同じことをするものが既にあるか」を確かめるために読む。
`docs/agents/common.md` から分離した（2026-09-07）。理由は 2 つ:

- **常時ロードの総量を空けるため。** `common.md` は `CLAUDE.md` の `@import` で毎セッション読み込まれ、
  この表はその 34%（6,871 字）を占めていた。**探すときだけ要るもの**を常に持ち歩く必要はない。
- **ルールと索引は寿命が違う。** ルールは滅多に変わらないが、この表はファイルが増えるたびに伸びる。
  同じファイルに置くと、索引が伸びるたびにルールを載せる余地が削られる。

## 既知の限界

- **読まれる保証が無い。** `common.md` にあったときは必ず目に入ったが、ここは読みに来ないと分からない。
  そのぶん「既にあるスクリプトを知らずに作り直す」事故が起こりうる。
  緩和は `common.md` からのポインタ 1 行と、`scripts/` を `grep` で引けること。**それ以上の保証は無い。**
- **この表の網羅性は誰も検査していない。** 新しいスクリプトを足しても、ここに書かなければ載らない。
  リンク切れ（消えたファイルを指したまま）は `scripts/lib/check-docs-integrity.mjs` が検知するが、
  「載せ忘れ」は検知できない。
- ルールブック（カタログ）の一覧は自動生成の [`rulebooks.md`](./rulebooks.md) が正本で、
  この表とは別物。ここに載っていないルールブックがありうる。

## 一覧

| ファイル | 目的 |
|---|---|
| [`docs/agents/common.md`](./common.md) | 全AIエージェント共通ルール（本ファイル）・引き継ぎフォーマット |
| [`docs/agents/observability-internals.md`](./observability-internals.md) | 観測・Eval基盤の実装詳細・既知の限界（common.mdから分離、issue #486） |
| [`docs/agents/test-matrix.md`](./test-matrix.md) | テスト種別ごとの実施タイミング（毎回/変更時/節目/一度きり）・トリガー・証跡・derive キーの正本。`scripts/check-test-matrix.test.sh`が整合を検査 |
| [`docs/agents/promise-catalog.md`](./promise-catalog.md) | auth / RLS / facility 境界の約束カタログ（AAA、`P-xxx`）。守るテストの `describe` 名に ID を書き、`scripts/check-promise-catalog.test.sh` が双方向に突合 |
| [`docs/agents/invariant-catalog.md`](./invariant-catalog.md) | 業務不変条件（`I-xxx`）。DB の CHECK / トリガーが守り、構造テストがテストと突合 |
| [`docs/agents/design-questions.md`](./design-questions.md) | 新しいテーブル・API・外部送信を作る**前に**人に聞く質問の一覧。2026-09-07 の点検で見つけた実害が全て「作る前に聞いていれば防げた」ものだったことから作った。決めた値もここに残す |
| [`docs/agents/security-test-catalog.md`](./security-test-catalog.md) | ルーチン外の検査の引き出し。新機能・事故・公開時に引き金列を読み #757 へ昇格 |
| [`docs/agents/threat-model.md`](./threat-model.md) | 脅威モデル（`T-xxx`）と守る検査（P / I / #757）の対応表。全 P / I がどれかの脅威に紐づくことを構造テストが検査 |
| `scripts/derive-test-selection.sh` / `scripts/lib/derive-test-selection.mjs` / `scripts/lib/derive-test-selection.rules.mjs` | 変更ファイルから「今回必須 / 今回不要（理由付き）」を機械導出し 04 表を出す（PR②）。エンジン（共通）とルール表（固有）を分離。高リスク判定は`router-risk.js`を参照 |
| [`docs/agents/tooling-decisions.md`](./tooling-decisions.md) | 公式機能・プラグインの導入可否判断記録（common.mdから分離、issue #486） |
| [`docs/agents/actuator-inventory.md`](./actuator-inventory.md) | 検知hookの検知後の是正（block/自動復旧/warning-only）の棚卸し（issue #578） |
| [`docs/agents/portability-inventory.md`](./portability-inventory.md) | 多リポジトリ展開に向けたドメイン非依存/スタック依存の切り分け棚卸し（issue #535） |
| [`docs/agents/parallel-agent-work.md`](./parallel-agent-work.md) | Claude Code / Codex 並行作業ルール（同一worktree同時作業禁止・状態分離） |
| [`docs/agents/claude-codex-coexistence-template.md`](./claude-codex-coexistence-template.md) | Claude/Codex共存設計のリポジトリ非依存テンプレート（9原則・実機検証手順・移植チェックリスト） |
| `scripts/check-branch-tool-ownership.sh` | ブランチ命名規約（codex/*・claude/*）と起動ツールの取り違えをSessionStartで警告（両ツール共有） |
| `scripts/codex-skip-marker-deny.sh` | Codex用ask→deny変換ラッパー（Codexはask未対応のため） |
| `docs/ai-config-map.md` | エージェント・スキル全体マップ |
| `src/app/` | Next.js App Router のページ・API Routes |
| `src/components/` | UI コンポーネント |
| `src/lib/supabase/` | Supabase クライアント・データ取得層 |
| `supabase/migrations/` | DBマイグレーション |
| `scripts/create-worktree.sh` | worktree作成 + `.env.local`/`.env.test`自動コピー（「ブランチ運用ルール」参照） |
| [`docs/agents/run-manifest.md`](./run-manifest.md) | AIDDフローのspecHash/baseCommit突合用Run Manifestのスキーマ |
| `scripts/log-agent-progress.sh` / `scripts/show-agent-status.sh` | サブエージェント進捗の記録・一覧表示（issue #18） |
| `aidd.config.json` / `scripts/lib/aidd-config.sh` | 導入先アダプター設定（issue #420）。TRI/RISK の固有語彙・読み取り専用ロール・検査コマンド・追記先 docs。判定エンジンと hook 4 本が読み、値は汎用既定値に足すだけで消せない |
| `scripts/build-plugin.sh` / `scripts/lib/plugin-layout.json` | プラグイン v1 の生成（issue #420）。層の表に従い `dist/plugins/` を機械生成し、禁止語・同梱閉包・決定性を検査。配布は `--marketplace --out ~/aidd-plugins/plugins`（版は `{plugin}--v{version}` タグ）。`build-plugin.test.sh` が dist の鮮度を見る |
| `scripts/lib/resolve-log-dir.sh` | `logs/`の書き込み先をworktree横断で単一のディレクトリ（メインworktree直下）に解決する。全`log-*.sh`/`check-*.sh`/`summarize-*.sh`が参照する（issue #546。worktreeごとに別の`logs/`へ書いて観測記録の約半数が死蔵していた対策） |
| `scripts/lib/canonical-event.ts` | hook/journal/agent-progress/loop-observabilityの4ログを正規化する読み取り専用Adapter層（issue #569） |
| `scripts/harvest-journal-events.sh` / `scripts/lib/harvest-journal-events.ts` | Workflow journal(wf_*)をtranscript cleanupで消える前に`logs/journal-harvest.jsonl`へ収穫（Stop hook契機・重複排除。issue #642） |
| `scripts/summarize-gate-passfail.sh` / `scripts/lib/gate-effectiveness-summary.ts` | 収穫済みjournalからagentType別pass/fail/blockedを集計し月次品質ゲートサマリへ出力（issue #569・#642） |
| `.claude/workflows/lib/constraint-coverage.js` | DB制約・RLS/admin境界・公開RPCの「守るテストが無い穴」の判定ロジック正本（issue #675、P-043） |
| `scripts/check-constraint-coverage.sh` | 現存する穴を**怪しい順**に表示。新規発生の阻止は`supabase/migrations/__tests__/constraint_coverage_ratchet.test.ts`が`npm test`で行う |
| `scripts/lib/scan-rls-grant-gaps.mjs` / `scripts/check-rls-grant-gaps.test.sh` | 層の食い違いの**片側**（E-055）。権限はあるが規則が無い＝**触れるが何も起きない道**を数える。逆向きも見る（規則はあるが権限が無い） |
| `supabase/migrations/20260909080000_add_assert_facility_owns.sql` / `supabase/__tests__/integration/rpc-reference-boundary.integration.test.ts` | **混乱した代理人**（正規の利用者が正規の RPC に他施設の ID を渡す）を止める共有部品と、その総当たり（2026-09-09）。`SECURITY DEFINER` の RPC は RLS を通らないので、参照先の持ち主の確認を関数ごとに手書きすると書き忘れる（1 日で 2 件出た）。`assert_facility_owns` に実装を 1 本化し、公開 RPC が全部登録簿にあることを ratchet で要求する |
| `scripts/lib/harness-registry.json` / `scripts/lib/render-harness-map.mjs` / `scripts/render-harness-map.sh` / `scripts/check-harness-map.test.sh` | **ハーネスの地図を生成する**（2026-09-10）。8 つの役割それぞれについて「何を守るか / **どうやって起動するか**（機械か人か外部待ちか）/ 入口 / 台帳 / 限界を書いた文書」を 1 か所に宣言し、`harness-map.md` の表を作り直す。**数字は台帳の実物から読む**（手で書いていたときに 2026-09-09 に 2 回取り違えた）。宣言した入口・検査・限界の文書が実在しなければ落ちる。**逆向きも見る**——`scripts/*.test.sh` と `scripts/lib/*.test.sh` の**全部**がどれか 1 つのハーネスに属していなければ落ちる（新しい検査を足した人に「どの役割を守るのか」を 1 回決めさせる）。エンジンは共通側、登録簿は導入先（配らない——中身が導入先のパスなので） |
| `scripts/show-harness-evidence.sh` | **役割ごとに「いま測れているか」を実測の記録から出す**（2026-09-10、レビューの設計提案 4）。地図の状態欄は手書きの「あり / 一部」で、登録簿自身が「『あり』は中身の十分性を保証しない」と書いていた。**測定 / 合格 / 最新 を潰さずに別々に**出す——一度も回していない・赤のまま・木が変わっている、は別の話。記録は機械ローカル（`logs/` は git 管理外）なので**コミットする文書へは焼き込まない**（焼き込むと環境ごとに生成物が割れ、C-010 を作り直すことになる）。限界: HEAD の木のハッシュだけを見る（未コミットの書き換えは Stop hook の担当） |
| `scripts/show-precision-metrics.sh` / `scripts/lib/precision-metrics.json` / `scripts/check-precision-metrics.test.sh` | **精度指標を役割別に出す**（2026-09-10、レビューの設計提案 3）。見逃し率・指摘の正確さ・実行可能率・変異撃破率を**1 つの数字に混ぜない**。どれも 分子 / **分母（予定した件数）** / 測れなかった件数 を別々に出し、**実行不能を分母から黙って消さない**。あわせて**同条件のばらつき**を出す。**条件（測った木・モデル）が同じ回どうしでしか比べない**——混ぜると、モデルの揺れと『その間にコードが変わっただけ』を区別できない。作った初日は条件を見ておらず「4 件が振れている」と出していたが、条件を記録するようにしたら比べられる回が 1 回ずつしか無かった（＝当時の数字は根拠不足だった）。**同じコミットで連続して回して直接観測した揺れ**（sweep-data が 2/2 → 1/2 → 2/2）は別途 NOTES.md にある。限界: 記録に残っている数字しか出せない。費用は `total_cost_usd`（表示価格ベース）なので**実際の請求と一致するとは限らない**。モックで回した eval からは取れないので、**取れなかった回を 0 円として足さず件数で出す** |
| `scripts/lib/agent-output.mjs` / `scripts/lib/record-eval-run.sh` / `scripts/check-agent-output.test.sh` | **eval の 1 回分（結果・条件・時間・費用）を記録する**（2026-09-10、設計提案 3「再現性と費用」）。`claude -p --output-format json` は中身を包みに入れて返し、`total_cost_usd` と `usage`（入出力トークン）が付く（2026-09-10 に最小 1 回で実測。`--json-schema` と併用できる）。`agent-output.mjs` がその包みを剥がすが、**包みが無い出力はそのまま通す**——eval のテストはモックに差し替えるので、包みを前提にすると測る道が実利用と変わる（C-023）。`record-eval-run.sh` が `docs/agents/eval-runs.jsonl` へ 1 行残す。**取れた回と取れなかった回を別々に数える**（`usageSamples` / `usageMissing`）——0 円と取れなかったを混ぜると費用が実際より安く見える。作った当日、既定値を `${1:-{}}` と書いたせいで bash が `}` を 1 つ余計に足し、**実測できた回まで「取れなかった」に落ちていた**（検査が掴んだ）。**キャッシュから読んだ入力は入力トークンに足さず別に並べる**——`usage.input_tokens` はキャッシュ分を含まず、実物の 1 回は入力 6 に対しキャッシュ読み 17,547 だった（足すと価格の違うものを 1 つの数にしてしまう。C-031）。**費用にも幅を出す**——実物を同じ条件で 2 回回したら、合否は 1/1 のまま費用が $0.1604 → $0.0519（約 3 倍）に振れた（キャッシュから読めた量の差）。1 回の金額は予算に使えない。限界: モックで回るテストからは費用が取れない。`total_cost_usd` は表示価格ベース。変異 CM-035〜CM-041 が反証を持つ |
| `docs/agents/harness-map.md` | **役割ごとのハーネスの地図**（2026-09-09）。データ・契約・セキュリティ・ミューテーション・監視・リリースの 6 役割について、何が揃っていて何が空いているかを 1 枚にした。空きは「手が届くもの」と「外部への到達が要るもの」に分けてある。**新しい仕組みを作る前にここを見る**（既にあるものを作り直さないため） |
| `src/lib/validation/parse-query.ts` / `scripts/lib/query-validation-baseline.json` / `scripts/check-query-validation-coverage.test.sh` | **クエリ文字列を読む唯一の入口**と、まだ移していない route の一覧（2026-09-09）。本文（`parseBody`）は 0 本まで移して閉じたが、クエリ文字列には同じ仕組みが無く、12 route が 26 か所を生読みしていた。判定が route ごとに手書きだったため `/api/news` の limit は小数が素通りしていた（E-053）。一覧は増やせない（maxPending の ratchet） |
| `scripts/lib/check-detectors-effective.mjs` / `scripts/lib/check-mutants.json` / `scripts/check-detectors-effective.test.sh` | **検知そのものが効いているか**を測る（C-022 の機械化、2026-09-09）。判定エンジンを 1 か所だけ壊し、対応する検査が本当に落ちるかを実測する。落ちなければ「生き残り」＝その検査は何も守っていない。初回の計測で 5 件が生き残り、いずれも本物の穴だった。壊し方は導入先の登録簿（`check-mutants.json`）に宣言する |
| `scripts/check-rls-mutation.test.sh` | **RLS 変異計測の数え方**を実 DB 無しで固定する（2026-09-10、R05）。supabase / vitest を差し替え口から偽物に替え、「壊す前から赤いテストを撃破に数えない」「計測不能があれば赤にする」「母数は対象件数のまま（1/1 に見せない）」を測る。直す前は未変異の対照が無く、実行エラー件数もどこにも効いていなかった |
| `scripts/check-test-entrypoints.test.sh` | **普通に打つ道がハーネスを通ることを固定する**（2026-09-10、R07）。`npm run test:integration` / `test:e2e` が記録ラッパー経由か、`ai:check` が両方を含むか、別名の script で実行系を直に叩いていないかを見る。直す前は npm の入口が vitest / playwright を直に叩いており、**記録の仕組みを作っても普通の道は通らなかった** |
| `scripts/check-shell-locale-safety.test.sh` | **検査を実利用のロケールで回しても落ちないことを固定する**（2026-09-10、R12・C-042）。bash 3.2 + UTF-8 では `"$VAR）"` の全角文字の先頭バイトを変数名の一部と読んで `set -u` で落ちる。実測で C ロケール 117/0 に対し ja_JP.UTF-8 は 101/16 だった。危ない書き方の走査と、「その書き方が実環境で本当に落ちる」対照の両方を持つ |
| `scripts/check-shell-expansion-safety.test.sh` | **bash の展開が静かに値を変える書き方を残さない**（2026-09-10）。`${VAR:-{}}` は bash が `${VAR:-{` までを展開と読み、残りの `}` を素の文字として後ろに足す。**引数を渡したときだけ壊れる**ので、既定値だけを試すと正しく見える。実害: eval の使用量を積む処理がこの形で、渡した JSON が `...}}` になって毎回読めず、**実測できた回まで「取れなかった」に落ちていた**。走査（0 件の ratchet）と、「その書き方が実際に値を壊す」対照の両方を持つ |
| `scripts/lib/judge-sweep-recall.py` / `scripts/lib/judge-sweep-recall.test.sh` | **Sweep の recall を採点する決定的ロジック**と、その回帰テスト（2026-09-10、R11）。直す前は「期待パスの部分文字列 AND 期待キーワード」だけを見ており、**「確認しましたが問題はありません」という見逃しの回答も HIT** にしていた。出力契約の `FINDINGS: <件数>`（無ければ「指摘なし」の語）で**指摘の有無**を先に判定し、`expectNoFinding` の**陰性対照 fixture** は逆向きに採点する |
| `scripts/run-integration-tests.sh` / `scripts/run-integration-tests.test.sh` | 統合テストの実行を包み、**結果を自己申告にしない**（exit code を `logs/integration-runs.jsonl` へ記録）。あわせて追記専用表の積み上がりを知らせ、**後片付けの漏れ（消し残し）を判定する**（2026-09-10。全件を回して緑のときだけ。報告が無ければ落とす）。2026-09-10 の実測で**緑の実行 1 回につき 41 行**が積み上がっていた（削除の戻り値のエラーを誰も見ていなかった。E-065） |
| `e2e/fixture-guard.ts` / `supabase/__tests__/integration/helpers/fixture-guard.ts` / `scripts/lib/fixture-guard.mjs` / `scripts/check-fixture-guard.test.sh` | **後片付けが自分の作った行以外を消していないか**を、E2E と統合テストの**両方**の前後で実測する（C-030 の機械化、2026-09-09）。走り出す前に「消えては困る行」を控え、終わったあとに 1 行でも消えていれば実行が失敗する。判定は DB を知らない共有エンジン側、実 DB の読み出しは `e2e/` 側、統合テスト固有の事情（控えが 0 件でも落とさない・**`process.exitCode` を立てないと vitest は落ちない**）は `supabase/__tests__/` 側 |
| `scripts/run-mutation-tests.sh` / `scripts/check-mutation-freshness.sh` / `scripts/check-mutation-freshness.test.sh` | **製品コードの変異計測（Stryker）の打ち忘れを拾う**（2026-09-10）。`npm run test:mutation` はラッパー経由になり、exit code と実測スコアを `logs/mutation-runs.jsonl` へ残す。見張る木は `src/` と **`stryker.config.json`**——**対象を減らせばスコアは上がる**ので、測る対象の一覧が変わったら前の記録は当てにしない |
| `scripts/check-rls-mutation-freshness.sh` / `scripts/check-rls-mutation-freshness.test.sh` | **RLS の変異計測を「ポリシーが変わったのに回していない」で拾う** SessionStart hook（2026-09-10）。この計測は人が打たないと動かない仕組みだったので、実行を `logs/rls-mutation-runs.jsonl` へ機械的に記録し（記録するのは exit code であって主張ではない）、「一度も無い / 前回が赤（生き残りあり）/ 前回から `supabase/` が変わっている / 汚れた木での合格」で警告する。判定は統合テスト・E2E と共有（`scripts/lib/run-freshness.py`。3 つ目を足しても判定は 1 つ）。定期の引き金（四半期・`maintenance-digest.sh`）とは役割が違う——あちらは「時間が経った」、こちらは「変わったのに測っていない」 |
| `scripts/check-full-run-before-finish.sh` / `scripts/lib/worktree-hash.sh` | **終える瞬間に「いまの状態で全件を通したか」を聞く** Stop hook（C-041 の機械化、2026-09-09）。判定は SessionStart 側と同じ `lib/run-freshness.py` だが、材料を HEAD の木から**未コミット・未追跡を含む「いまの姿」のハッシュ**へ広げた。セッションに 1 回・警告のみ |
| `scripts/lib/check-write-path-gaps.mjs` / `scripts/lib/write-path-registry.json` / `scripts/check-write-path-gaps.test.sh` | 層の食い違いの**逆側**（E-056 / E-057、2026-09-09）。**DB は書けるのにアプリに道が無い**組み合わせを数え、理由の宣言を要求して件数を増やせなくする（ratchet）。エンジンは共通・登録簿は導入先 |
| [`docs/agents/operation-contracts.md`](./operation-contracts.md) / `scripts/lib/check-operation-contracts.mjs` / `scripts/check-operation-contracts.test.sh` | **1 操作（表 × 動詞）= 1 行**の契約（O-xxx、2026-09-09）。入口・直接書き込みの可否・認可・危険度を宣言し、DB 権限／アプリの直接書き込み／入口の実在／攻撃表への登録と**両方向**で突き合わせる。決める単位を、実際に穴が開く単位に揃えるための正本 |
| `scripts/check-agent-progress-gap.sh` | agent-progress記録漏れの機械検知（issue #339） |
| `scripts/record-gap-check-state.sh` | gap check用before/expected件数の記録（issue #488。オーケストレーター専用） |
| `scripts/check-gap-check-state.sh` | Stop hookによるgap checkの自動実行（issue #488） |
| `scripts/check-aidd-stats-recorded.sh` | Stop hookによるAIDD stats start呼び忘れの機械検知（issue #495） |
| `scripts/check-aidd-phase-stats-recorded.sh` | Stop hookによるAIDD stats phase1/phase2呼び忘れの機械検知（issue #524） |
| `scripts/check-handoff-format.sh` | Stop hookによるPR本文の引き継ぎフォーマット必須見出し欠如の機械検知（issue #524） |
| `scripts/check-find-av-precision-recorded.sh` | Stop hookによるfind-av-precisionログ記録漏れの機械検知（issue #522） |
| [`docs/agents/recovery-queue.md`](./recovery-queue.md) | 検知後の自動復旧閉ループの設計・スコープ・既知の限界（issue #523） |
| `scripts/queue-recovery-task.sh` | 検知hookから呼ばれ`.aidd/recovery-queue.jsonl`へ復旧タスクを登録する（issue #523） |
| `scripts/check-recovery-queue.sh` | SessionStart hookによる未解決の復旧タスクのcontext注入・surfaced放置エントリのエスカレーション（issue #523・#579） |
| `scripts/resolve-recovery-task.sh` | 復旧タスク対応後に`status`を`"resolved"`へ書き換える（issue #579） |
| `scripts/check-workflow-interruption.sh` | SessionStart hookによるWorkflow中断検知(`wf_*.json`のstatus/staleness判定)とrecovery-queueへの登録（issue #534） |
| [`docs/agents/fault-injection-drill.md`](./fault-injection-drill.md) | `aidd-phase2.js`のdeny-by-defaultゲート実測訓練のランブック（issue #395） |
| [`docs/agents/hook-live-drill.md`](./hook-live-drill.md) | 全 hook を現在セッションの実データで実走し、fail-open の無音死を見つけるランブックと実施記録（2026-09-05 初回で 7 件発見。プラグイン v1 前の必須作業） |
| [`docs/agents/upstream-docs-review.md`](./upstream-docs-review.md) | Claude Code / Anthropic / Codex の公式ドキュメント差分を月 1 で確認する手順・実施記録・「最後に確認した版」（v1 の対応バージョンの正本）。期限は `scripts/check-upstream-docs-review-staleness.sh` が SessionStart で警告 |
| `scripts/maintenance-digest.sh` | 定期作業 3 つ（fault-injection 訓練・hook 実走ドリル・docs 差分確認）の期限を一括表示。`claude -p --maintenance`（Setup hook）または手動実行（issue #741） |
| `scripts/log-instructions-loaded.sh` / `scripts/summarize-instructions-loaded.sh` | InstructionsLoaded hook で実際に読み込まれた CLAUDE.md / rules を `logs/instructions-loaded.jsonl` に記録し、常時ロード量と rules 別ロード回数を集計する（issue #742。月次サマリにも載る） |
| `scripts/check-subagent-model-force.sh` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` が設定されていると agent ごとの model 指定が黙って無効化されるため SessionStart で警告（issue #743） |
| `scripts/aidd-fault-injection-setup.sh` / `scripts/aidd-fault-injection-teardown.sh` | fault injection訓練用の`.aidd/run-manifest.json`差し替え・復元（issue #395） |
| `scripts/eval-workflow-prompts.sh` / `scripts/eval-fixtures/` | AIDDワークフロープロンプトのeval基盤（issue #391） |
| `.claude/workflows/lib/prompts/` | ワークフロー内プロンプト文字列の正本（Workflow DSL側へはインライン複製、sync testで乖離検知） |
| `.claude/workflows/lib/budget-guard.js` | Loop Until Dryへのbudgetガード判定ロジックの正本（issue #442） |
| [`docs/agents/workflow-resume-runbook.md`](./workflow-resume-runbook.md) | Workflow実行が中断した際の`resumeFromRunId`再開手順（issue #442） |
