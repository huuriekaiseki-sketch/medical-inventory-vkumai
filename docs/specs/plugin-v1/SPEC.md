# AIDD パイプライン プラグイン v1 仕様書（issue #420）

作成日: 2026-09-05。停止①（人間レビュー）用。Part 1 が承認対象、Part 2・3 は AI 用の技術詳細。

---

## Part 1 — 仕様（★人間がレビューする部分）

### 1. 何ができるようになるか

vkumai で育てた AIDD の仕組み（調査 → 仕様 → 実装 → 統合 → 検証の流れ、品質ゲート、検知 hook、
証跡の記録）を、**別のリポジトリに「インストール」するだけで使える**ようにする。

今は新しいリポジトリで使うたびに `.claude/` 配下と `scripts/` を手でコピーし、リポジトリ固有の
値（危険なパス、ロール名、テストコマンド）を探して書き換えている。v1 では次のようになる。

1. 導入先で `claude plugin install aidd-core@<配布元>` を 1 回実行する（配布元は後述の「配布形態」で決める）
2. 導入先のリポジトリ直下に設定ファイル `aidd.config.json` を 1 つ置く（危険なパス・ロール名・
   テストコマンドなど、そのリポジトリ固有の値だけを書く）
3. `.claude/rules/`（パス限定ルール）と `CLAUDE.md` は導入先が自分で持つ（プラグインは同梱できない）
4. これで vkumai と同じ Workflow・エージェント・hook が動く。vkumai 側の改良は、プラグインの
   版を上げて `claude plugin update` すれば導入先に届く

### 2. 3 層の分け方（ユーザー指示 2026-09-05）

| 層 | 実体 | 入っているもの | 誰が変えるか |
|---|---|---|---|
| **共通プラグイン `aidd-core`** | プラグイン（配布物） | Workflow 5 本・エージェント 11 体・スキル 3 つ・hook（記録／検知の共通分）・判定エンジン（TRI/RISK の分岐ロジック、derive のエンジン、gap check、recovery queue） | vkumai で作ってから配る。導入先は触らない |
| **vkumai アダプター `aidd-vkumai`** | プラグイン（`aidd-core` に依存） | Supabase の DDL ガード、医療データ向け autoMode 警告、生成型の鮮度、E2E（Playwright）ランナー | vkumai だけが使う |
| **導入先アダプター** | 各リポジトリの `.claude/` と `aidd.config.json` | `CLAUDE.md`、`.claude/rules/*.md`、permissions、テストコマンド、危険パス・ドメイン語、テスト一覧の行、約束カタログの行、derive のルール表 | 各リポジトリ |

「vkumai 専用設定をそのまま汎用プラグインにしない」を守るため、**共通プラグインには vkumai・
medical・facility・Supabase・npm の語を 1 つも残さない**（構造テストで機械検査する）。

### 3. 各バージョンで必ず残す 7 項目（ユーザー指示）と置き場所

| # | 項目 | 置き場所（プラグインリポジトリ内） | 正本の出どころ |
|---|---|---|---|
| 1 | 対応する Claude Code・Codex のバージョン | `COMPATIBILITY.md` | vkumai の `docs/agents/upstream-docs-review.md`「最後に確認した版」 |
| 2 | プラグインの設定スキーマ | `schema/aidd-config.schema.json`（正本は中心リポジトリの `scripts/lib/aidd-config.schema.json`） | 本仕様 Part 2 の設定項目一覧 |
| 3 | v1→v2 の移行手順 | `MIGRATION.md`（v1 では「v0（手コピー）→ v1」を書く） | 実際に riff-gear / cardiosearch を移行して書く |
| 4 | 互換性を壊す変更の一覧 | `BREAKING.md` | 列・ID 規約・設定キーの変更はすべて破壊的変更扱い（`user_format_is_the_key`） |
| 5 | 共通 fixture による回帰テスト | `tests/`（構造テスト `*.test.sh`・vitest・eval fixture・fault-injection fixture） | vkumai の `scripts/*.test.sh`・`.claude/workflows/lib/__tests__/`・`scripts/eval-fixtures/` |
| 6 | vkumai での実証結果 | `evidence/vkumai-<日付>.md` | vkumai の `docs/agents/hook-live-drill.md`・`fault-injection-drill.md`・`docs/agents/eval-runs.jsonl` |
| 7 | 変更履歴と既知の制約 | `CHANGELOG.md`・`KNOWN-LIMITS.md` | 本仕様の「既知の制約」節から開始 |

### 4. v1 の範囲（入れるもの・入れないもの）

**入れるもの**
- Claude Code 向けプラグイン 2 つ（`aidd-core`・`aidd-vkumai`）と、導入先設定ファイルの形式
- vkumai から「生成」する仕組み（下記 5.）と、生成物が vkumai と同じ振る舞いをすることの検証
- クリーンな検証用リポジトリでのインストール → `aidd-phase1` 実走 → 検知 hook の実走ドリル

**入れないもの（v1 の既知の制約として明記）**
- Codex 向けの配布。Codex にはプラグイン機構が無いため、`.codex/hooks.json` と `.codex/agents/*.toml`
  は導入先アダプターに手コピーのまま（v2 候補）
- marketplace への公開。配布形態は事業判断のため、v1 は「ローカルディレクトリ or 非公開 git リポジトリ」
- `.mcp.json`・permissions・`logs/`・`docs/sessions/` の同梱（issue 本文どおり）
- ホーム直下の個人スクリプト（`~/write_aidd_stats.sh`・`~/.claude/pending_issues.jsonl`）。
  これらは「フレームワークの一部か個人習慣か」が未決（`portability-inventory.md`）。v1 では
  導入先 CLAUDE.md に「任意」と書くに留める

### 5. vkumai を中心に置く方法（一番大事な設計判断）

**v1 では、プラグインは vkumai から機械生成する配布物にする。** 正本は vkumai の `.claude/` と
`scripts/` のまま。生成スクリプトが次を行う。

- エージェント名に名前空間を付ける（`agentType: 'sweep-ui'` → `'aidd-core:sweep-ui'`。7 月の試作で
  これが無く 4 体全滅した実績あり）
- hook の登録を `settings.json` から `hooks/hooks.json` へ変換し、パスを `$CLAUDE_PROJECT_DIR/scripts/`
  から `${CLAUDE_PLUGIN_ROOT}/scripts/` に書き換える
- vkumai 固有の語を含むファイルを `aidd-vkumai` 側に振り分け、共通側に残っていないことを検査する

これにより「新しい仕組みは vkumai で先に作り、他リポジトリは受け取るだけ」「逆流禁止」が
**手順ではなく構造**として守られる。vkumai 本体の `.claude/` は無変更で動き続ける（issue の完了条件）。
v2 以降で「プラグインが正本、vkumai も消費者」へ反転するかは、v1 を 2 リポジトリで回してから決める。

代替案（採らない）: 最初からプラグインリポジトリを正本にし vkumai を消費者にする。
今の vkumai は 1 日に数 PR の速度で hook が増えており、その都度プラグイン側を経由すると開発が
止まる。また vkumai の構造テスト（同期テスト 30 本超）がプラグイン側の変更を検知できなくなる。

### 6. 受け入れ条件（チェックリスト）

- [x] クリーンな検証用リポジトリ（git init 直後）で `claude --plugin-dir <生成物> -p` から `aidd-phase1` を
      起動し、sweep 4 体が**実際に起動**する（7 月の `agent type not found` が再発しない）
      → 2026-09-05 実測: `Workflow({name: 'aidd-vkumai:aidd-phase1'})` で 4 体とも起動、`failedCount: 0`
      （空リポジトリのため自己申告 `blockedCount: 4`）。1 セッション $0.41（haiku 4 体込み）
- [x] 同じ検証用リポジトリで、`hook-live-drill.md` の手順で共通 hook を全件実走し、無音死が 0 件
      → 2026-09-05: SessionStart / Stop / InstructionsLoaded / SubagentStart・Stop をプラグイン経由で実走。
      2 件の無音死（manifest の `hooks` 重複、`cd` のスクリプト位置基準）を発見し同日修正、再実走で 0 件。
      PreToolUse 5 本は未実走（`hook-live-drill.md` に記録。次回の RED 確認で埋める）
- [x] fault-injection 訓練 4 シナリオがプラグイン経由でも `blocked` を返す
      → 2026-09-06: 4 シナリオとも期待どおり（Spec Check 1・Manifest Check 3、いずれも正しい理由。約 $0.8）。
      7 月の #399（args.specPath 無視）は再現せず。`fault-injection-drill.md` 実施記録参照
- [x] vkumai 本体で `npm test`・`hooks-test` CI が無変更で green（本体の既存フローが動き続ける）
      → PR #749 / #750 / #752 とも CI 全 green。本体の `.claude/settings.json` の hooks は変更なし
- [x] 共通プラグイン内に vkumai / medical / facility / supabase / npm の語が無いことを構造テストが保証
      → 生成スクリプトの禁止語検査（コメント込み、`plugin-layout.json` の forbiddenWords）。違反があれば出力しない
- [x] 7 項目のファイルがすべて存在し、`COMPATIBILITY.md` の版が vkumai の「最後に確認した版」と一致
      → 2026-09-05: 正本 `docs/plugin/`（5 文書＋`evidence/`＋`templates/consumer/`）を生成スクリプトが
      両プラグインのルートへコピー。版の一致は `scripts/build-plugin.test.sh` scenario 4b が機械検査
- [x] 生成スクリプトを 2 回続けて実行しても差分が出ない（決定的） → 同 scenario 1
- [x] 導入先設定 `aidd.config.json` を空にしても共通プラグインが安全側（高リスク扱い）で動く
      → `aidd-config.test.js`（設定が空でも auth / rls / policy / migration は deep）と hook 4 本のテスト（設定無し→汎用既定）

### 7. 配布形態（2026-09-05 ユーザー決定済み）

- **最終形は (a) 非公開 git リポジトリ `aidd-plugins`**（marketplace.json 同梱、
  `claude plugin install aidd-core@aidd-plugins`）。導入先が vkumai 本体（医療在庫の製品コード）を
  clone せずに済み、移行手順・互換性を壊す変更・変更履歴を版に紐づけて管理できる
- **受け入れ条件が通るまでの検証は (b) vkumai 内 `dist/plugins/`** に生成物を置き、
  `claude --plugin-dir` で読む。生成スクリプトの出力先を変えるだけで (a) へ移せる
- リポジトリ作成（GitHub 上の操作）はユーザー側の作業。受け入れ条件が通った時点で依頼する

**仕様承認**: 2026-09-05 ユーザー承認（停止①通過）。

### 8. 既知の制約（KNOWN-LIMITS.md の初期内容）

- プラグインは `.claude/rules/` と `CLAUDE.md` を同梱できない。パス限定ルール（DB スキーマ、E2E 衛生、
  Workflow eval 義務）は導入先が持つ
- プラグイン同梱の subagent では frontmatter の `hooks` / `permissionMode` / `mcpServers` が無視される。
  ロール別ガードは hooks.json の PreToolUse + `agent_type` 判定（#713 方式）
- Workflow は導入先の設定ファイルを読めない（fs API 無し）。導入先固有の値は Workflow 引数で渡す
  （導入先の薄い wrapper Workflow が担う。下記 Part 2）
- hook の出力先 `logs/` は導入先のメインワークツリー直下（`resolve_log_dir`）。プラグインの
  `${CLAUDE_PLUGIN_DATA}` には置かない（証跡はリポジトリに属する）
- 公式 docs と実装の差（`memory_type` 等）は都度 `upstream-docs-review.md` に記録し、版の対応表で吸収する

---

## Part 2 — 実装計画（AI 用・レビュー不要）

### 層の切り方の修正（2026-09-05、ユーザー承認）

実測で「Workflow 5 本・エージェント 11 体を共通側に」は v1.0 では成立しないと分かった（sweep 4 軸と
implementer 系 7 体はスタック固有語を含み、Workflow はそれらを名前で呼ぶ。名前空間はプラグイン単位なので
共通が固有側を参照する逆依存になる）。v1.0 は**機構を共通側**にする: 共通 = hook 一式・共通関数・
判定エンジン・固有語の無いエージェント 4 体（reviewer / adversarial-verify / completeness-critic /
judge-panel）・スキル 2 つ。Workflow 5 本と残り 7 体、e2e-runner / handoff-format、Supabase・npm・
医療向けの hook 5 本は vkumai アダプター。層の表は `scripts/lib/plugin-layout.json` が正本で、
共通側に固有語が 1 つでもあれば生成が失敗する。Workflow とエージェントの共通化は、プロンプト本文の
汎用化（eval の結果が変わる）として v1.x で 1 本ずつ移す。

### 実装セット一覧（依存順）

| セット | 内容 | 触るファイル | 波 |
|---|---|---|---|
| **A. 切り分け表の確定** | hook 登録 33 件（スクリプト 32 本、`log-subagent-hook-skeleton.sh` が 2 イベント共用）・scripts・agents 11・skills 4・workflows 5・lib を core / vkumai / 導入先 の 3 列に確定し `portability-inventory.md` に表として固定。語彙検査の禁止語リストを決める | `docs/agents/portability-inventory.md` | 波 1 |
| **B. 設定の外出し（vkumai 側で先に実装）** | `aidd.config.json` のスキーマ（riskPathPrefixes / riskKeywords / metaPathPrefixes / readonlyAgentTypes / commands.test / commands.lint / docs.domain / docs.decisions / logDir）。`router-risk.js` は `classifyRoute(input, config)` の形で config を受け、既定値は「auth / rls / policy / migrations」の汎用のみ。vkumai の値は `aidd.config.json`（リポジトリ直下）に移す。hook 側（`check-readonly-bash.sh`・`check-run-manifest-presence.sh`・`ai-check-suggest.sh`・`check-domain-decisions-suggest.sh`）は jq で同ファイルを読む | `.claude/workflows/lib/router-risk.js`、`aidd-phase1-router.js`（インライン複製と sync test）、`scripts/check-readonly-bash.sh`、`scripts/check-run-manifest-presence.sh`、`scripts/ai-check-suggest.sh`、`scripts/check-domain-decisions-suggest.sh`、各 `.test.sh`、新規 `aidd.config.json`・`schema/` | 波 1（A と別ファイル） |
| **C. 生成スクリプト** | `scripts/build-plugin.sh`（新規）: (1) A の表に従いファイルをコピー、(2) `agentType: '<name>'` を `'aidd-core:<name>'` へ書き換え、(3) `settings.json` の hooks から hooks.json を生成しパスを `${CLAUDE_PLUGIN_ROOT}` へ、(4) `plugin.json`（name / version / dependencies）を生成、(5) 禁止語検査、(6) 2 回実行の差分ゼロ検査。テストは `scripts/build-plugin.test.sh` | 新規 `scripts/build-plugin.sh`・`.test.sh`、`scripts/lib/plugin-manifest.jq` | 波 2（A・B 完了後） |
| **D. プラグインリポジトリの骨格** | 7 項目のファイル、`tests/` に vkumai の構造テストを生成物に対して回す CI（bash + vitest）、`evidence/` | 新規リポジトリ（(a) の場合）または `dist/plugins/`（(b) の場合） | 波 2（C と別ファイル） |
| **E. 導入先アダプターの雛形** | `.claude/workflows/aidd-phase1-router.js`（5 行の wrapper: `workflow('aidd-core:aidd-phase1-router', { ...args, ...config })`）、`aidd.config.json` の例、`CLAUDE.md` の最小テンプレ、`.claude/rules/` の説明。`bootstrap-agent-coexistence` スキルと統合するか要検討 | 新規 `templates/consumer/` | 波 2 |
| **F. 検証** | クリーン検証リポジトリで受け入れ条件 8 件を実測。結果を `evidence/vkumai-2026-09.md` と `hook-live-drill.md` に記録 | 検証用リポジトリ、`docs/agents/hook-live-drill.md` | 波 3（統合ゲート後） |

共有ファイル（`portability-inventory.md`、`settings.json`）を触る結線は統合ゲートへ。

### 各セットのテスト観点

- **B**: `router-risk.test.js` に「config 未指定 → 汎用既定値で高リスク側に倒れる」「vkumai の config で従来と同じ判定」の 2 系統。`router-risk-sync.test.js` がインライン複製の追従を検知。hook 側は `.test.sh` に「config 無し → 既定」「config あり → 上書き」
- **C**: 生成物に `agentType: '` の非修飾参照が 0 件、禁止語 0 件、hooks.json が jq で妥当、2 回実行で `diff -r` 空
- **D**: プラグインリポジトリの CI が vkumai の `hooks-test` と同じテストを生成物に対して回して green
- **F**: RED 方向を必ず含める（名前空間を意図的に外した生成物で `agent type not found` が **エラーとして** 見えること。#521 の修正により `failedCount` に出る）

### 要検証 → 実測結果（2026-09-05、Claude Code 2.1.258、scratchpad の最小プラグイン 2 つを
`claude -p --plugin-dir` で読み込み、1 セッション $0.20 で確認）

1. **Workflow 名も名前空間付き**（`aidd-core-spike:spike-inner`）。DSL 内の `workflow('spike-inner')` も
   メインエージェントの `Workflow({name: 'spike-flow'})` も、非修飾は「no workflow with that name」で失敗する
   （エラー文に利用可能な修飾名一覧が出る）。agent も同様（7 月試作の再現。`agent type 'echo-agent' not found`）
   → 生成スクリプトは agentType と workflow() の両方を書き換え、導入先 CLAUDE.md の呼び出し例も修飾名にする
2. **`${CLAUDE_PLUGIN_ROOT}` は hook の command で展開される**（プラグインディレクトリの絶対パス）。
   hook 内の `CLAUDE_PROJECT_DIR` と cwd は導入先で、`git rev-parse --git-common-dir` も導入先の `.git` を
   返す → `resolve_log_dir` はそのまま導入先の `logs/` に解決する
3. **別プラグインの agent / workflow を修飾名で呼べる**（adapter → core）。`dependencies` の解決順は
   `--plugin-dir` 2 つ同時指定では検証できていない（両方明示ロードのため）。marketplace 経由の
   インストールで再確認する
4. 未検証（両方ロードすれば当然二重に発火する）。運用で「vkumai 本体では生成物を読まない」とし、
   生成スクリプトの出力先を `dist/plugins/` に固定してリポジトリ内 `.claude/` と混ざらないようにする
5. **InstructionsLoaded の出力は文脈に入らない**（hook は発火し stdin も来るが、additionalContext /
   systemMessage とも無視）。hooks docs が正しく、plugins-reference の記述は誤り → `upstream-docs-review.md` に記録

### 型・データアクセス層の方針

該当なし（プロダクトコード・DB に触れない）。設定ファイルは JSON Schema（draft 2020-12）で型を持ち、
`schema/aidd.config.schema.json` を `npm test`（vitest）で `aidd.config.json` に対して検証する。

### 費用と規模の見積もり

- B は vkumai 側の変更で PR 2〜3 本（router-risk / hooks / config）。既存テスト 30 本超が守る
- C・D・E は新規ファイルのみで PR 2 本
- F の実走は `claude -p` と Workflow 実行で数ドル規模（fault-injection 4 シナリオ込み）
- 全体で 3〜4 セッション。停止②（構造化レビュー）は F の前に置く

---

## Part 3 — 仕様レビュー前セルフチェック（AI 用・レビュー不要）

- UI 変更なし → モック不要（対象外）
- 新しい列挙: 3 層（core / vkumai / 導入先）。各ファイルがどの層に入るかの判定基準は Part 2 の A で
  表として固定し、件数を数えて本文の合計（hook 登録 33 件・スクリプト 32 本 / agents 11 / skills 4 / workflows 5。2026-09-05 に `settings.json` と `ls` で実測）と一致させる
- 下流の反応: `aidd.config.json` が無い・空のとき → 高リスク側の既定値（Part 1 受け入れ条件 8 件目）。
  禁止語検査に引っかかったとき → 生成失敗（exit 1）で配布物を作らない
- 信号の意味変更: `classifyRoute` の入出力は変えず、config を追加引数にする。既存の呼び出し
  （`aidd-phase1-router.js`・`derive-test-selection.mjs`）は config 省略で従来どおり動く
- 包含・除外リスト: Part 1 の 4.「入れるもの・入れないもの」は表ではなく箇条書きだが、件数を伴わない
  ため数え直しは不要
