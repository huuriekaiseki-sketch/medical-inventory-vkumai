# 公式ドキュメント差分の定期確認（upstream docs review）

Claude Code・Anthropic・OpenAI/Codex の公式ドキュメントは数週間単位で更新される（2026-08〜09 の
1 か月で Claude Code は約 20 版）。「業界推奨を網羅したか」は 1 回の調査で決まる状態ではなく、
**定期的に差分を見て、この表と同じ形で判定し直す**作業として持つ。fault-injection 訓練
（[`fault-injection-drill.md`](./fault-injection-drill.md)）と同じ型で、「次回実施予定日」を
SessionStart hook（`scripts/check-upstream-docs-review-staleness.sh`）が監視する。

プラグイン v1（issue #420）の各バージョンで残す「対応する Claude Code・Codex のバージョン」は、
本ファイルの「最後に確認した版」を正本にする。

## 次回実施予定日

2026-12-08（月 1 の目安。Claude Code のマイナー版が 10 個以上進んだとき、または v1 の各バージョン前は
予定日を待たず実施する。実施後に手動で書き換える。期限は SessionStart の個別警告に加え、
`claude -p --maintenance`（`scripts/maintenance-digest.sh`、issue #741）で他の定期作業とまとめて確認できる。
3 回目（2026-11-08）は手順 1〜3 のみの軽量実施だったので、次回は手順 5 も回す）

## 最後に確認した版

| 対象 | 版 / 日付 | 確認日 |
|---|---|---|
| Claude Code | 2.1.322（changelog の先頭。手元は、PATH 上の CLI が 2.1.289、デスクトップアプリのセッションが 2.1.321） | 2026-11-11 |
| Codex CLI | 0.167.1（2026-11-10。0.169 は alpha のみ。手元は 0.147.0） | 2026-11-11 |
| Anthropic engineering blog | 最新記事 2026-11-06「The components of agent memory」 | 2026-11-08 |
| Claude Platform release notes | 2026-11-09 の Claude Fable 5.2 まで | 2026-11-11 |

## 手順（1〜2 時間）

1. **差分を取る**（WebFetch で要約。日付でフィルタさせると要約器が誤るので「先頭から N 版」で取る。
   **Claude Code の changelog だけは `curl` で全文を取り、判定に使う項目は原文の行を読む**——要約は「〜のときだけ」の
   条件節を落とし、2026-11-08 の判定が 3 件ずれた。下の 2026-11-11 の節）
   - Claude Code changelog: `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
     （「最後に確認した版」より新しい版の項目を全部。hooks / subagent / compaction / plugin / workflow /
     sandbox / permission / skill の語を含む項目は省略させない）
   - Claude Code docs: `hooks`・`sub-agents`・`plugins-reference`・`memory`・`context-window`
     （イベント一覧・frontmatter フィールド・プラグイン構成要素・読み込み仕様の**現行値**を取り、
     前回の記録と突き合わせる）
   - Anthropic engineering: `https://www.anthropic.com/engineering`（新記事の有無）
   - Codex: `https://learn.chatgpt.com/docs/changelog`（旧 developers.openai.com/codex/changelog はリダイレクト）
2. **判定する**: 各項目を「v1 設計に効く制約 / 取り込む価値あり / 対応不要」の 3 つに分け、
   取り込むものは issue 化する（小粒なら #654 バックログへ束ねる）
3. **記録する**: 下の実施記録に追記し、「最後に確認した版」と「次回実施予定日」を更新する
4. **必要なら実走する**: hook のイベントや transcript 形式が変わっていたら
   [`hook-live-drill.md`](./hook-live-drill.md) を回す（形式変化は fail-open hook を無音で殺す）
5. **プロンプトとスキルの棚卸し**（issue #905、2026-10-24 から）: 本体が新しいモデル向けに書き方を変えたとき、
   このリポジトリの CLAUDE.md / skills / agents は古い書き方のまま残る。2 つのコマンドを非対話で回して結果を実施記録に貼る
   （hook の再帰発火を避けるため `--settings '{"disableAllHooks":true}'` と `--no-session-persistence` を付ける）:
   - `claude -p "/doctor prompt-audit" --settings '{"disableAllHooks":true}' --no-session-persistence --max-turns 3`
     （2.1.283。旧モデル向けの書き方を監査する。指摘が出たら 1 件ずつ issue 化するか、その場で直す）
   - `claude -p "/skill-doctor" --settings '{"disableAllHooks":true}' --no-session-persistence --max-turns 3`
     （2.1.252。スキルごとの context コストと使用頻度。**個人スキル（userSettings）は個人の判断**で、
     ここで見るのは projectSettings の行——0 回のまま残っているプロジェクトスキルは消すか統合するかを決める）
   どちらも人が打つ。結果で見直し対象が出たら issue 化する

## 実施記録

### 2026-09-05（初回。issue #420 の v1 準備として）

範囲: Claude Code 2.1.239〜2.1.261、Codex 0.150〜0.153、Anthropic engineering（新記事なし）。
このセッションでの 7 案（グラフマニフェスト #710、常時ロード量 #711、compaction 再注入 #712、
読み取り専用ガード #713、docs GC #714、TRI/RISK 同期 #715、スキル上限 #716）を実装した直後の確認。

**v1 設計に効く制約（issue #420 にコメント済み）**
- プラグインは `.claude/rules/` を同梱できない。CLAUDE.md も読まれない。path-scoped rules は導入先アダプター側に残す
- プラグインの `settings.json` は `agent` / `subagentStatusLine` のみ。permissions・hooks は書けない。hook は `hooks/hooks.json` で同梱
- プラグイン同梱の subagent では frontmatter の `hooks` / `permissionMode` / `mcpServers` が無視される（#713 の settings.json 方式が正解）
- Workflows は `workflows/` で同梱可。`dependencies` に semver 制約付きで依存プラグインを書ける

**取り込む価値あり（issue 化）**
- `Setup` hook（`claude -p --maintenance`）を定期作業の入口にする → issue #741
- `InstructionsLoaded` hook で常時ロード量を実測に置き換える → issue #742（同日実装。実測で docs との差を 1 件確認:
  `memory_type` の実値は docs の `instructions` でなく `User` / `Project`（2.1.258）。次回の差分確認で docs 側が追従したか見る）
- プラグイン v1 の要検証 5 件を実機確認（`docs/specs/plugin-v1/SPEC.md` Part 2）。docs との差をもう 1 件確認:
  plugins-reference は「`InstructionsLoaded` hook で `${CLAUDE_PLUGIN_ROOT}/instructions.md` を cat すれば
  文脈に注入できる」例を載せているが、hooks docs の「このイベントの出力は全て無視される」が正しい
  （2.1.258 実測: additionalContext / systemMessage とも文脈に現れない）。Workflow 名もプラグイン名で
  修飾される（`plugin:workflow`）ことは docs に明記がなく実測で確定
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` が AIDD のモデル階層を無効化するため検知する → issue #743
- `/skill-doctor`（2.1.261）で未使用スキルと context コストを 1 回測る（手動）
- `subagentPromptCacheTtl` / frontmatter `experimental.cacheTtl`（1h）は `/cost` の cache miss 原因を見てから判断

**対応不要**
- `PostCompact` hook: 案 3 は SessionStart(compact) で実装済みで実機動作を確認。移す必要なし
- 2.1.260 の「Workflow subagent が長い compaction 中に stalled 扱いで再起動」修正: check-workflow-interruption の staleness 近似（4 時間）は安全側に動く
- MEMORY.md の上限 200 行 / 25KB: 現状余裕あり
- Codex 0.150 の Interrupt hook: Codex 実機待ちの issue #653 に束ねる

**このセッションで先行して潰した無音死（差分確認と並行の実走ドリル）**: [`hook-live-drill.md`](./hook-live-drill.md) 参照

### 2026-10-23（2 回目。SessionStart の期限切れ警告から 18 日遅れ）

範囲: Claude Code 2.1.263〜2.1.309（changelog に日付なし。欠番 2.1.262 / 264 / 279 / 297 / 298）、
Codex 0.154.0〜0.163.0、Anthropic engineering（新記事 2 本: 05-25 封じ込め・10-13 ソース管理）＋
claude.com / claude.dev の実践記事（09-28〜10-22 の 4 本）、OpenAI developers blog（日付記載なし）。
取得は 4 体の subagent（changelog は curl で全文、docs は `code.claude.com/docs/en/<slug>.md` の原文）。
**手元の Claude Code は 2.1.289** なので、下の「取り込む」のうち 2.1.295 以降の機能は本体更新が前提。
→ **2026-11-12 訂正**: 2.1.289 は PATH 上の CLI の版。この回のセッション自体はデスクトップアプリで、本体は 2.1.308 だった（下の 11-12 の節）。

**v1 設計に効く制約・注意（docs / changelog から）**
- 2.1.288: PreToolUse / PermissionRequest の matcher 失敗・入力のシリアライズ失敗は**スキップでなく block** になった（fail-closed 側へ。歓迎）。2.1.299: plugin hook に値を渡せない・答えを受け取れないときも refuse
- 2.1.300: `updatedInput` はツール入力と同じ検証を受け、未知キーは落ちる（このリポジトリの hook は `updatedInput` を返していない。grep で確認）
- 2.1.300: ローカル transcript に各 API リクエストの system prompt / tools / parameters も記録される。
  transcript を読む検査（`log-subagent-hook-skeleton.sh` / `verify-agent-progress-transcript.ts` / `check-aidd-*-recorded.sh` 等 12 本）の入力形が変わりうる。Codex 側も docs が「transcript の形式は安定 interface ではない」と明言
- 2.1.271 以降 **auto mode では subagent の報告が `SubagentHandback` ツール経由**になり、`SubagentStop` の `last_assistant_message` は報告ではない（docs 明記）。**実測**: 2026-10-23 のこのセッション（auto mode）で起動した 4 体の `SubagentStop` 行（`logs/subagent-skeleton.jsonl`）に `lastAssistantMessage` が無い。骨格記録の「完了時の最終アシスタントメッセージ」は auto mode では空になっている。報告本文は `PreToolUse` / `PostToolUse` を matcher `SubagentHandback` で受け、`tool_input.message` から取る（下の「取り込む」3）
- 2.1.277: subagent の結果は「subagent output」ヘッダ付き・インデントで main に届く（05-25 記事の「サブエージェント出力を生のツール結果より高い信頼に昇格させない」の実装）。結果の本文を解析する側は形式変化に注意
- 2.1.294: path-scoped rules とネスト CLAUDE.md が **Bash の cat / sed -n / grep でも発火**するようになった（auto mode は Bash で読むので、2.1.289 では `db-schema.md` が発火していなかった）。2.1.288: Write / Edit でも発火
- 2.1.302: `-p` / SDK の既定 permission mode が条件付きで `default` に戻った（第三者 provider・テレメトリ off・新規インストール）。2.1.285: unattended の background コマンドは 30 分上限
- 2.1.277: `TaskOutput` ツール削除（リポジトリに参照なし。grep で確認）
- `claude -p --bare`（docs 推奨・将来の `-p` の既定）は **サブスクリプション認証を使わず `ANTHROPIC_API_KEY` が必須**。`verify-claims.sh` 等の `--setting-sources ""` を `--bare` に置き換えると課金経路が変わるので、人の判断なしに入れない
- Codex: PreToolUse が `ask` を返すと hook 失敗扱いでツールは続行（= 既存の deny ラッパー方針が正しい）。hook の信頼はハッシュ管理で、変更された hook は信頼されるまで**黙ってスキップ**（`docs/plugin/RELEASE.md` §4.3 に実測つきで整理済み）。`gpt-5.5` は 10-14 に ChatGPT サインインで退役（`.codex/config.toml` にモデル指定なし。grep で確認）

**取り込む価値あり（番号は優先順。着手は人が決める）**
1. **止める hook に `onFailure: "block"`（2.1.295）**。対象は actuator-inventory で block / ask / deny の 4 本
   （`check-direct-ddl-execution` / `check-readonly-bash` / `check-dependency-change` / `check-skip-marker-write`）。
   jq 不在は既に exit 2 で fail-closed だが、**timeout 5 秒超過とスクリプトのクラッシュ（exit 1）は今も素通り**
   （docs: "a timed-out hook doesn't block the tool call ... don't count on a stalled hook to act as a gate"）。
   warning-only の hook には付けない（timeout で作業が止まる）。付け方: `.claude/settings.json` の該当 4 本に
   `"onFailure": "block"` → 配布物 `hooks/hooks.json` は `build-plugin.sh` の生成なので生成側も → 構造テストに
   「actuator-inventory で block / ask / deny の hook は `onFailure: "block"` を持つ」の突合を足す（宣言と実物の対）→
   実走ドリル: hook を `sleep 10` に差し替えて timeout させ、`timed out; blocking because onFailure is "block"` の文言で
   deny を確認（C-020: 「何かが起きた」でなく理由文を見る）。**前提: 本体 2.1.295 以上**。古い版で未知キーが
   設定ファイルごと無視されないかは未確認（`attribution: false` は旧版で設定ファイルがスキップされた前例あり）。
   Codex 側に相当機能は無い（KNOWN-LIMITS に書く）
2. **`verify` スキル規約（2.1.286）**。リポジトリの `.claude/skills/` 直下に `verify` という名前のスキルを新設すると（まだ無い）、Claude Code のコミット指示が
   「docs / tests だけの変更を除き、コミット直前に必ず `verify` を実行」になる（`includeGitInstructions` が on のとき）。
   中身は `bash scripts/derive-test-selection.sh origin/main --format table` で要る検査を導き、回せるものは回し、
   回せないものは「未実施と理由」を 04 表の 4 値で書く手順（09-28 の Sonnet 5.5 記事「実際に動かす検査をしてから
   完了報告、できなければ未実行のチェックと理由を書く」と同じ型）。セッション冒頭に出ていた 4 本の鮮度警告
   （統合 / E2E / Stryker / RLS）の受け皿になる。起動は LLM 依存（第 3 層）なので、実行の痕跡を
   `check-full-run-before-finish.sh`（Stop）と突き合わせる
3. **`SubagentHandback` の報告本文を骨格記録に足す**。`PostToolUse` に matcher `SubagentHandback` を 1 本足し、
   `log-subagent-hook-skeleton.sh` に event 分岐を追加して `tool_input.message`・`agent_id`・`agent_type` を
   `subagent-skeleton.jsonl` へ書く。上の実測（auto mode で最終メッセージ欄が空）の是正で、
   `verify-agent-progress-transcript` の突合材料にもなる。小粒（スクリプト 1 本＋settings 1 行＋テスト）
4. **`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`（2.1.296）を `check-subagent-model-force.sh` の検知対象に足す**
   （issue #743 の延長。workflow agent だけを 1 モデルに寄せる変数で、AIDD のモデル階層を黙って無効化する）。1 行＋テスト
5. **`/doctor prompt-audit`（2.1.283）と `/skill-doctor` を本手順の 1 項目にする**。CLAUDE.md / skills / agents の
   「旧モデル向けの書き方」を監査する。OpenAI 側も「新モデルが出たら補正プロンプトを見直す」「AGENTS.md は状況に
   紐づくポインタに絞り、モデルが既にやるテスト実行の指示は削る」と同じ方向。人が打つ・結果で issue 化
6. **effort 階層の実測**。2.1.267 で Fable 等 effort 固定モデルでも frontmatter `effort` が効くようになった
   （それ以前は 13 体の `effort: low` 等が無視されていた可能性）。2.1.292 の Agent ツール `effort` 引数が
   Workflow の `agent()` にも渡せるかと合わせ、OTel `llm_request` span の `effort` 属性（2.1.274）か `/cost` で
   **先に測る**（直す案はその後。`feedback_measure_before_recommending_fix`）
   → **2026-10-24 実測済み**（issue #906）。sonnet / opus では frontmatter の値が `output_config.effort` にそのまま乗り、
   haiku には effort 自体が送られない（sweep 4 本の `low` は API 上 no-op）。階層は変えない。根拠と抜粋は
   [`decisions/aidd-pipeline.md`「なぜ agent の effort を実測してから階層を見直すことにしたか」](./decisions/aidd-pipeline.md#なぜ-agent-の-effort-を実測してから階層を見直すことにしたかissue-906)
7. **eval 運用に「ノイズ幅」と「held-out」を足す**（09-28 Anthropic「Automating eval design and hillclimbing」）。
   `eval-sweep-recall.sh` / `eval-workflow-prompts.sh` の fixture を train / test に分け、run 間分散を
   `docs/agents/eval-runs.jsonl` に残し、改善がノイズ幅以下なら採用しない。1 ラウンド 1 パッチ。
   deep ルートの recall 11/17 → 5/17（issue #796）はこの型で防げた種類。中粒・#654 へ束ねる候補
8. **Codex の hook イベント追加（SubagentStart / SubagentStop / PreCompact / PostCompact / SessionEnd）への追従**。
   Claude 側の骨格記録（SubagentStart / Stop）と Supabase 自動停止（SessionEnd）が Codex に無い。
   parity 仕様書 07 の未対応分なので、**着手はユーザー指示があるまでしない**（2026-09-30 の決定）
9. **Codex hook の実機確認の機械化**（OpenAI「Testing Agent Skills Systematically with Evals」）。
   `codex exec --json --full-auto` の JSONL（`command_execution` / `turn.completed`）で hook の発火を決定論的に
   採点できる可能性。「05 は非対話モードでは確かめる手段が無い」（2026-09-29）の再検討材料。要実機確認
   → **2026-10-24 実測（issue #909）**: stdout の JSONL には deny が item として出ない。stderr の
   `Command blocked by PreToolUse hook` と rollout の `custom_tool_call_output` で判定する。手順は
   `docs/agents/hook-live-drill.md`「Codex 側: `codex exec --json` での機械確認」。05 の hook 自身の失敗は対象外のまま

**対応不要（理由つき）**
- idle compaction（2.1.299、54 分放置で compact）: `SessionStart(compact)` の再注入が同じく走る（matcher `auto` に含む）。恩恵のみ
- `PostCompact` hook: SessionStart(compact) で代替済み（前回と同じ判定）
- `ConfigChange` hook（project settings の変更を block できる）: settings.json を書くのは人とこのセッションだけ。DB 側の設定ドリフトは別物（`check-config-drift.sh`）
- Claude Mods（2.1.287、hooks module）: settings.json の hooks で足りている。配布物の構成を増やさない
- `claude plugin eval`（2.1.269、with / without の 2 アーム）: aidd-core の skill に eval を付ける価値はあるが、導入先の実績ゼロの段階で検査を増やすのは 09-28 の決定（プラグインは配れるもので完成、先回りしない）に反する。#654 へ
- `memory: project` / `context: fork` / Codex async hooks / Codex Rules: #654 のまま
- auto mode 分類器の実測（05-25 記事: 過剰行動のすり抜け 17%、無害の誤ブロック 0.4%）: hard_deny を分類器の内側の 1 層として維持。本命の sandbox は issue #438（TLS 非互換）で保留のまま。2.1.271 の per-command `allowed_domains` と 2.1.29x〜30x の sandbox 修正が多いので、**#438 の再検証を次回の差分確認に紐づける**
- 「スコープを行動の直前に再掲する」（09-09 記事: 直前ターンなら 90% 停止、3 ターン前だと 40%）: `check-run-manifest-presence.sh` が高リスクパスの Write / Edit 直前に additionalContext で出している。既にある
- Managed Agents の Outcomes（別コンテキストの grader が差し戻す）: aidd-phase2 の reviewer / judge-panel が同形
- OpenAI「Custom Code Review rules」の「発火すべき変更・安全な反例・無関係な変更の 3 つで試す」: C-021（出る側の対）と RED fixture の運用が同じ
- 「同質なエージェントは相関して失敗する」（08-13 記事）: sweep 4 本は層が違い、proposer 3 案はスタンスで散らしている

**取得できなかったもの**: Anthropic engineering の「See more」の奥 3 本、`openai.com/index/harness-engineering/`（403、2026-02 の記事で期間外）、
Codex 0.154〜0.156 は GitHub タグページの要約のみ、hooks.md の Elicitation / PreModelSwitch の入力詳細。

**実走の要否（手順 4）**: hook イベントの形式変化は無いが、2.1.300 の transcript 形式変更と 2.1.271 の `SubagentHandback` が
骨格記録の中身を変えている（上の実測）。本体を 2.1.295 以上へ更新したあと、`hook-live-drill.md` を subagent 系 2 本だけ回す。

### 2026-10-24（手順 5 の 1 回目。issue #905）

`claude -p "/skill-doctor"` と `claude -p "/doctor prompt-audit" --max-turns 60`（`--max-turns 3` では
「Reached max turns」で終わる。監査はファイルを読んで回るので 60 程度が要る）を、`--settings '{"disableAllHooks":true}'`
`--no-session-persistence` で回した。本体 2.1.289。

**`/skill-doctor`**: 読み込まれるスキル 180 本前後のうち **87 本が一度も起動されていない**（ほぼ個人設定の
デザイン系。1 本あたり毎ターン 20〜260 トークンの一覧行）。claude.ai 同期の 14 本も未使用。
projectSettings では `e2e-runner` と `aidd-session-report` が 0 回、`structured-review` 22 回・
`feature-spec` 25 回・`handoff-format` 29 回・`aidd-phase1-router` 16 回・`aidd-phase2` 14 回。
個人側の整理は個人の判断。プロジェクト側は `e2e-runner` / `aidd-session-report` の扱いを次回までに決める。

**`/doctor prompt-audit`**（編集は未適用。高 7・中 9・低 11。プロジェクト側は issue 化、個人設定側は本人へ報告）:
- 事実のずれ（高）: `AGENTS.md` の `ai:check` の説明に `test:integration` が無い／`contract-writer` が sonnet と
  書かれているが実ファイルは haiku／`spec-drafter` が一覧に無い。`handoff-format` スキルの相対リンク
  `../../docs/agents/...` はスキルの置き場からは `.claude` 直下の docs を指して実在しない（`../../../docs/` が正）。
  `feature-spec` の「STEP 7 の e2e-runner」の参照先が無い
- 矛盾（中）: ルート `CLAUDE.md` の「確認を求めるのは停止①②の 2 箇所のみ」と、後から足した依存変更の承認
  （`common.md`）・新規テーブルの設計質問（`db-schema.md`）が食い違う。例外として明記する方向
- 経緯の語り（中）: `common.md` 148〜153 行、ルート `CLAUDE.md` 80〜85 行（Fable 5 固定）、rules 3 本、
  `sweep-*.md` の「issue #675 の教訓」見出し等に日付・件数・issue 番号が残る。規則の根拠は挙動で、
  経緯は `decisions.md` へ（理由の文は残す）
- 低（flag のみ）: `judge-panel` の 1〜5 点採点を Workflow が読んでいない／`feature-spec` の「design スキル」が
  一覧に無い／祖先の `~/medical-inventory-vkumai/CLAUDE.md` と worktree 側が二重に読み込まれる（環境要因）
- 個人設定側（`~/.claude/`。このリポジトリでは直さない）: デザインスキルの symlink の説明が実態（7 本だけ symlink）と
  違う／`learned` の `favicon` は非推奨／`mentor`・`solopreneur`・`obsidian-daily-log` に期限切れの固定値／
  `medical-ai` のモデル ID 固定／`chain-parallel` の URL 入力時の分岐と重複した強調

生の出力は個人情報（スキル本文に書かれた個人の計画・資産）を含むため PR には貼らない。

### 2026-11-08（3 回目。軽量実施。手順 1〜3 のみ）

きっかけは「新しいワークフロー系の機能が追加されていないか」という問い。予定日（11-23）の 15 日前だが、
Claude Code のマイナー版が前回から 10 個進んでいたので前倒しで実施した。**手順 4（実走）と手順 5
（prompt-audit / skill-doctor）は回していない**（手順 5 は 10-24 に 1 回目を回したばかり）。
調査は別セッション（「新しいワークフロー調査」、アーカイブ済み）で行い、結果はこの記録以外に残していない。

範囲: Claude Code 2.1.310〜2.1.319、Codex 0.164〜0.167、Claude Platform release notes（10-24 以降）、
Anthropic engineering、OpenAI deprecations。**手元の Claude Code は 2.1.289 のまま**（前回と同じ）。
→ **2026-11-12 訂正**: 2.1.289 は PATH 上の CLI の版。この回のセッションはデスクトップアプリで、本体は 2.1.317 だった（下の 11-12 の節）。

**v1 設計に効く制約・注意**
- 2.1.312: prompt hook / agent hook の**同時実行が 24 件まで**。AIDD の fan-out（sweep 4 本＋Find の多数起動）で
  上限に当たりうる。超過分が待たされるのか落ちるのかは changelog の要約だけでは分からない（docs 原文は未確認）。
  落ちる側なら無音なので、骨格記録（`subagent-skeleton.jsonl`）の件数と起動数の突合（gap check）で初めて見える。
  次に deep ルートを回すときは起動数が 24 を超えた区間の記録漏れを疑う
  → **2026-11-11 訂正**: 対象は prompt 型 / agent 型の hook だけで、このリポジトリの hook（command 型）には当たらない。下の 11-11 の節
- 2.1.319: auto mode が分類器へフォールバックしなくなった。hard_deny を「分類器の内側の 1 層」として維持する
  判断（前回）はそのまま。分類器に頼っていた挙動が変わるので、auto mode での実機差を次の実走で見る
  → **2026-11-11 訂正**: テレメトリか feature flag を切っているときだけの変更。下の 11-11 の節
- 2.1.314: `permissions.blockWritesOutsideWorkingDirectories`。worktree 運用（`logs/` は全 worktree 共有、
  `~/.claude/` への書き込みあり）では壊れうるものがある。Bash 経由の書き込みにも効くかは未確認なので、入れるなら対象を調べてから
  → **2026-11-11 確認**: 対象は Write / Edit / NotebookEdit だけ。Bash は対象外。下の 11-11 の節
- Codex: hooks イベントが 14 種（PreModelRequest / PostModelRequest / PermissionRequest / Interrupt /
  PreCompact / PostCompact / SubagentStart 等）。PreToolUse の deny は `hookSpecificOutput.permissionDecision: deny`
  （exit 2 も可）。既存の deny ラッパー方針と整合。追従は issue #908（ユーザー指示があるまで着手しない。2026-09-30 の決定）
- Anthropic engineering 11-06「The components of agent memory」: auto memory の `MEMORY.md` は**先頭 200 行 / 25 KB
  しか読まれない**と明記。前回「余裕あり」としたが、**このリポジトリ用の個人側 MEMORY.md は 2026-11-08 時点で
  120 行 / 30,984 バイトで 25 KB を超えている**（後半の行は読まれていない可能性）。個人設定なのでここでは直さない

**取り込む価値あり（番号は優先順。着手は人が決める）**
1. **`permissions.denyInsteadOfPrompting`（2.1.319）**。無人実行で permission prompt 待ちになる代わりに deny して続行する。
   AIDD の無人 Workflow 実行で「prompt 待ちのまま止まる」ことを防ぐ候補（止まった回数は未集計。
   `check-workflow-interruption` の記録で数えてから入れるか決める）。**前提: 本体 2.1.319 以上**。`-p` 実行（verify-claims 等）に付けるか、Workflow 中だけかは分けて判断
2. **`CLAUDE_CODE_SUBAGENT_EFFORT`（2.1.316）を `check-subagent-model-force.sh` の検知対象に足す**。
   issue #743 / 前回 4 番（`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`）と同じ型で、環境変数 1 本で AIDD の effort 階層が
   黙って上書きされる。1 行＋テスト。effort の実測（issue #906）で haiku には effort が送られないので、効くのは sonnet / opus の agent
   → **2026-11-11 訂正**: 上書きはしない（他に指定が無いときだけ効く）。影響するのは effort 未指定の `implementer` だけ。下の 11-11 の節
3. **Claude Managed Agents の dynamic workflows（beta、2026-10-09）**。エージェント自身が「多数のエージェントを phase で走らせ結果を
   まとめるプログラム」を書き、サーバーが workflow run として回す（`multiagent: {type: multiagent_20261001, workflows: {type: enabled}}`、
   beta header `managed-agents-2026-04-01`、イベント `workflow_run.*`。1 run 同時 64 スレッド・総 1,000 agent・寿命 24h・
   セッション同時 10 run）。Claude Code の Workflow ツールと同じ発想のサーバー側版。**今は対応不要**（AIDD は Claude Code の
   Workflow で足りている）が、ハーネスをサーバー側へ移す選択肢として記録。ワークフロー本体のスキーマは docs に無い（agent が書く）

**対応不要（理由つき）**
- Claude Code 2.1.319 の MCP tasks 背景実行、2.1.318 の workflows の usage limit 後 resume 修正: 恩恵のみ
- Codex `/presets`（0.164）、`codex agents` command center（0.167）、`codex queue --resume`（0.166）: 対話操作の機能。hook・配布物に影響なし
- OpenAI Agent Builder と Evals の 2026-11-30 停止（Evals は 10-31 から read-only。移行先は Agents SDK / ChatGPT Workspace Agents、
  Evals は Promptfoo）: このリポジトリは OpenAI Evals を使っていない
- ChatGPT Scheduled tasks のイベントトリガー（GitHub PR アクティビティ等。CLI では定義不可）: 使っていない

**取得できなかったもの**: `openai.com` は fetcher に 403 を返すので InfoQ と `developers.openai.com/api/docs/deprecations` で代替した。
dynamic workflows の本体スキーマ（docs に無い）。Claude Code 2.1.310〜319 の各項目は changelog の要約のみで docs 原文は未確認。

**実走の要否（手順 4）**: hook イベントの入出力形式の変化は changelog 上は無い。前回からの持ち越し（本体 2.1.295 以上へ更新したあと
`hook-live-drill.md` を subagent 系 2 本だけ回す）はそのまま。

### 2026-11-11（3 回目の訂正と追補。changelog を原文で読み直した）

11-08 の記録は changelog を要約器（WebFetch）経由で読んでいた。同じ範囲を `curl` で全文取得して読み直したところ、
**要約が条件節（「〜のときだけ」「〜型の hook は」）を落としていて、判定が 3 件ずれていた**。11-08 の節の該当行には
「→ 2026-11-11 訂正」を付け、根拠はここに書く。あわせて 11-08 以降の新着（2.1.321 / 2.1.322、Codex 0.167.1）を足す。
**手順 4・5 は今回も回していない。Claude Code の docs ページ（hooks / sub-agents / plugins-reference）の現行値の突き合わせもしていない。**

範囲: Claude Code 2.1.310〜2.1.322（changelog 原文。欠番 2.1.313 / 315 / 320）、Codex 0.164.0〜0.167.1（GitHub releases の一覧と
`learn.chatgpt.com/docs/changelog`。後者は一部が要約経由）、Claude Platform release notes（09-28〜11-09）、
Managed Agents の workflow runs の docs 原文、Anthropic engineering、OpenAI deprecations。手元は Claude Code 2.1.289 / Codex 0.147.0 のまま。
→ **2026-11-12 訂正**: 2.1.289 は PATH 上の CLI の版。この回のセッションはデスクトップアプリで、本体は 2.1.317（途中から 2.1.321）だった（下の 11-12 の節）。

**11-08 の記録の訂正（changelog 原文で確認）**
- **hook の同時実行 24 件（2.1.312）は prompt 型 / agent 型の hook だけが対象**（セッションあたり 24 本まで、subagent 分を含む。
  加えて、イベントの timeout より長く待った分が 12 本まで）。このリポジトリの hook は全部 command 型で、
  `.claude/settings.json` と個人設定に prompt 型 / agent 型は 0 本（grep で確認）。**fan-out 時に骨格記録を取りこぼす、という
  11-08 の懸念は当たらない**。「起動数が 24 を超えた区間の記録漏れを疑う」は取り下げる
- **`CLAUDE_CODE_SUBAGENT_EFFORT`（2.1.316）は上書きしない**。他に effort の指定が無い subagent にだけ効く（セッションの effort を
  継ぐ代わりにこの値になる）。AIDD の 13 体のうち frontmatter に `effort:` が無いのは `implementer` だけ（`grep -L` で確認）なので、
  影響はその 1 体に限られる。「検知対象に足す」は優先度を下げる。入れるなら対象は「effort 未指定の agent があるときだけ警告」
  - 関連（2.1.317）: メインと違うモデルで動く subagent は、セッションの effort でなく、そのモデルの保存済み effort か既定値を使うようになった。
    これも effort 未指定の agent にだけ効く
- **auto mode の分類器フォールバック廃止（2.1.319）は、テレメトリか feature flag を切っているとき（LLM gateway 越しを含む）だけ**。
  個人設定・プロジェクト設定に `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` /
  `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` は無い（grep で確認。シェルで export している場合は別）。「次の実走で実機差を見る」は不要
- **`permissions.blockWritesOutsideWorkingDirectories`（2.1.314）の対象は Write / Edit / NotebookEdit だけ**。Bash 経由の書き込みと
  hook スクリプトの書き込み（`logs/`）は対象外。壊れうるのは作業ディレクトリ外への Write / Edit（個人側 memory への書き込み等）
- `permissions.denyInsteadOfPrompting`（2.1.319）の適用範囲は「ターミナルのセッション・subagent・teammate」と書かれている。
  `claude -p` での挙動は changelog に無い（verify-claims 等に付ける判断の前に実測が要る）
- Managed Agents dynamic workflows の上限（1 run 同時 64 スレッド・総 1,000 agent・寿命 24h・セッション同時 10 run）は
  `platform.claude.com/docs/en/managed-agents/workflow-runs.md` の原文の表で一致を確認。同時 64 は「保証しない」との注記つき

**11-08 の見落とし（2.1.310〜2.1.319。手元 2.1.289 に効くもの）**
→ **2026-11-12 訂正**: 「手元 2.1.289」は PATH 上の CLI と、それを `claude -p` で呼ぶスクリプトの話。デスクトップアプリのセッションは
2.1.317 以上で動いていて、下の 2.1.314 / 2.1.319 の修正は版の上では入っている（効くことの実測はしていない。下の 11-12 の節）。
- **2.1.314: matcher が Bash の hook は、Monitor ツールが起動するシェルコマンドに走っていなかった**（修正後は block / ask はできるが
  approve / 書き換えはできない）。このリポジトリの止める hook 4 本（`check-skip-marker-write` / `check-dependency-change` /
  `check-direct-ddl-execution` / `check-readonly-bash`）は matcher に Bash を使う。**2.1.289 では Monitor 経由のコマンドが
  この 4 本を素通りしうる。未実測**。本体を 2.1.314 以上にしたあと `hook-live-drill.md` で Monitor 経由の deny を 1 本確かめる
- **2.1.319: 許可チェックのすり抜け修正 4 件**（引用符つきの語で Bash の deny / ask ルールを外せた／`sed` が accept-edits と auto mode で
  許可チェックを飛ばせた／環境変数プレフィックスでコマンドの一部を隠せた／worktree 作成時の sandbox escape）。hook でなく本体の
  許可ルール側の穴で、2.1.289 は未修正。**本体更新の理由になる**（#910 の「2.1.295 以上が要る」と同じ方向）
- 2.1.314: `--setting-sources` で除外した設定ファイルから、auto mode のルールや保存済みの許可が一部読まれていた。
  `verify-claims.sh` / `eval-workflow-prompts.sh` / `eval-sweep-recall.sh` / `workflow-nesting-drill.sh` がこの指定を使う
  （「設定を継がない」前提が 2.1.289 では完全ではない）。2.1.317: `--setting-sources` を使う実行で古い transcript が掃除されない不具合も修正
- 2.1.311: `SubagentStop` hook が完了時の 1 回でなく、動作中の subagent ごとに毎分 2 回ほど走っていた。**実測**: `logs/subagent-skeleton.jsonl` の
  2026-10-01 以降、SubagentStop のある 56 体のうち 49 体が 1 行・7 体が 2 行。大量の重複は起きていない（2 行の 7 体の原因は未調査）
  → **2026-11-12 調査済み**: 7 体のうち 6 体は agent 型 hook の評価役（1〜2 秒差）。56 体の大半も subagent ではなかった（下の 11-12 の節）
- 2.1.319: `claude plugin update` が、新しい版で足された依存プラグインを入れていなかった（`docs/plugin/COMPATIBILITY.md` の
  「依存側は自動で上がらず個別 update」の実測は 2.1.270 のもの。次の配布時に測り直す）
- 2.1.318: 背景の subagent はシェルコマンドを 3 分で背景へ回す。2.1.311: subagent の隔離 worktree が、その subagent が起動した
  背景 subagent の作業中に消される不具合を修正。2.1.311: 自動 compaction 直後に古い `MEMORY.md` / `CLAUDE.md` が見えていた不具合を修正

**11-08 以降の新着**
- **Claude Code 2.1.321: Claude Fable 5.2（`claude-fable-5-2`）が Fable の既定**。保存済みの Fable 5.1 の選択は `fable` へ移る。
  ルート `CLAUDE.md` の `/goal` のターン数（Fable 5 の実測で 20 → 15 に校正、issue #498）は「モデル世代が変わったら見直す」条件に当たる。
  agent / workflow にモデル ID の固定は無い（`fable` を grep、コメント 1 件のみ）
  - 同版: workflow を止める・一時停止したことが Claude に伝わっていなかった不具合を修正／auto mode で、背景 subagent の報告が
    compaction をまたぐと失われる不具合を修正／`claude -p` の背景コマンドは 10 分で止まる（30 分と伝えていた誤りを修正。
    10-23 の節の「unattended の background コマンドは 30 分上限」は `-p` では 10 分と読む）／`cp` / `mv` でディレクトリへ書き込むファイルに
    deny ルールが効いていなかった不具合を修正／PreToolUse の `ask` が別 hook の `defer` で失われる不具合を修正
- Claude Code 2.1.322: Vertex の fast mode のみ。対応不要
- **Codex 0.167.1（2026-11-10）**: 0.167.0 からの変更の記載なし。0.169 は alpha。0.164 に「プラグインの hook の承認をプラグインの中身に結びつける」、
  0.166 に「PreToolUse hook へコマンドの作業ディレクトリを渡す」、0.167 に「PreToolUse hook を Guardian の確認より先に適用する」がある
  （いずれも PR タイトルのみ。hook の信頼まわりは次の配布時に `docs/plugin/RELEASE.md` §4.3 を測り直す）
- Claude Platform: 11-09 Fable 5.2 / Mythos 5.2（入力 $8・出力 $40 / MTok。5.1 は $10・$50）。11-02 message threads（beta）。
  10-21 API version `2026-10-21` と SDK のメジャー版。10-14 OpenTelemetry export（beta）。このリポジトリは API を直接呼ばないので対応不要
- Anthropic: engineering の最新は 11-06 のまま。claude.com/blog に 11-09「Safely scaling multi-agent teams with Claude Fable 5.2」
  （1,000 エージェントの運用。**一覧の要約だけで本文は未読**）
- OpenAI deprecations: Agent Builder / Evals に加え **Reusable prompts（`v1/prompts`）も 2026-11-30 停止**。`gpt-5.3-codex` は 2027-04-01 停止
  （`.codex/config.toml` にモデル指定は無い）

**副産物（原因未調査。別件）**: 2026-11-11 のセッション（デスクトップアプリ、auto mode）で起動した subagent 3 体は、
`logs/subagent-skeleton.jsonl` に `SubagentHandback` の行だけがあり、`SubagentStart` / `SubagentStop` の行が無い。2026-10-01 以降の集計でも
SubagentStart のある agent は 6 体、SubagentStop のある agent は 56 体で食い違う。gap check の期待件数（起動数）と骨格記録の突合に効くので、
仮説の前に transcript で「hook が呼ばれたか」を数える
→ **2026-11-12 調査済み**: 欠けるのは web-fetch の subagent だけ。「6 体と 56 体の食い違い」は欠落ではなかった（下の 11-12 の節）

**取得できなかったもの・読んでいないもの**: Codex の changelog ページは 22 万字のうち約 8 万字だけ原文で、残りは要約経由（0.163〜0.166 の版の境目は近似）。
claude.com/blog は 1 ページ目のみ。Claude Code の docs ページは未確認。

**教訓（手順 1 への反映）**: changelog は要約させず `curl` で全文を取り、判定に使う項目は原文の 1 行を読む。手順 1 の
「WebFetch で要約」は、項目の拾い出しまでにとどめる。

### 2026-11-12（11-11 の節の訂正。骨格記録の欠落を調べた）

11-11 の節の「副産物（原因未調査）」を調べた。その途中で、**これまでの節が「手元の Claude Code」と書いてきた 2.1.289 は
PATH 上の CLI の版で、デスクトップアプリのセッションは別の版の本体で動いている**と分かった。該当行には「→ 2026-11-12 訂正」を付け、
根拠はここに書く。docs の差分確認そのもの（手順 1〜5）は回していない。「最後に確認した版」と次回実施予定日は動かさない。

**デスクトップアプリのセッションの本体の版（transcript の各行の `version` を数えた）**
- 10-23 のセッション: 2.1.308／11-08 のセッション: 2.1.317／11-11 のセッション: 2.1.317 から途中で 2.1.321。3 つとも `entrypoint` は `claude-desktop`
- `claude --version` は 2.1.289。これは PATH 上の CLI の版で、`claude -p` を呼ぶスクリプト（`verify-claims.sh` / `eval-workflow-prompts.sh` /
  `eval-sweep-recall.sh` / `workflow-nesting-drill.sh`）が使うのはこちら（スクリプトが PATH の `claude` を呼ぶ、という読みで、実行時の版は測っていない）
- **版に依存する判定は、`claude --version` でなく、対象のセッションの transcript の `version` で見る**

**11-11 の節の読み替え**
- 「2.1.289 では、止める hook 4 本が Monitor ツール経由のコマンドを素通りしうる」（2.1.314 の修正）と「許可チェックのすり抜け 4 件は未修正」
  （2.1.319 の修正）は、**CLI と `claude -p` の側の話**。デスクトップアプリのセッションは 2.1.317 以上で、版の上では修正が入っている。
  **どちらの側も実測はしていない**（デスクトップ側で Monitor 経由の deny が実際に止まるかも未確認）
- `onFailure`（2.1.295 以上。#910）は、デスクトップアプリのセッションでは版の条件を満たしている。`hook-live-drill.md` の該当分は、
  CLI の更新を待たずにデスクトップアプリのセッションから回せる可能性がある（未実施）
- 10-23・11-08 の節にある「2.1.289 では〜」という判定は、その回のセッションが 2.1.308 / 2.1.317 だったことを踏まえて読む。
  **個別の読み直しはしていない。** 他の docs の「本体 2.1.289」（`ai-config-map.md` / `hook-live-drill.md` / `tooling-decisions.md` /
  `decisions/aidd-pipeline.md`）も、CLI で測ったものかデスクトップアプリで測ったものかは未確認

**骨格記録（`logs/subagent-skeleton.jsonl`）の欠落の調査結果**
- **本当に欠けるのは web-fetch の subagent だけ。** 11-08 以降の 11 体（本体 2.1.317 と 2.1.321）すべてで、`SubagentHandback` の行だけがあり、
  `SubagentStart` / `SubagentStop` の行が無い。**対照実験**: 同じセッション・同じ本体 2.1.321 で、Explore と web-fetch を 1 体ずつ同じ応答の中で起動した。
  Explore は Start / Handback / Stop の 3 行、web-fetch は Handback の 1 行だけだった。changelog（全文を grep）に該当する記述は無い
- **「SubagentStart のある agent 6 体・SubagentStop のある agent 56 体」の食い違いは欠落ではなかった。** `agentType` が空の `SubagentStop` 行は
  subagent ではなく、本体の内部 agent が出している（次の入力の候補を作る agent・compaction の要約・agent 型 hook の評価役）。これらは
  `SubagentStart` を出さない。全期間で 1,642 行（`SubagentStop` 行の半分強）。内訳は、`lastAssistantMessage` が 60 字以下の 1 行のもの 1,473 行・
  analysis / summary のタグで始まるもの 34 行・それ以外 135 行。`agentTranscriptPath` の指すファイルは 1 つも残っていない
- **`agentType` のある agent には、Stop だけあって Start が無いものは 0 体**（全期間。Start 1,453 体・Stop 1,438 体・Start だけで Stop が無いもの 15 体）
- `SubagentStop` が 2 行ある 7 体（11-11 の節）のうち、6 体は `agentId` が `hook-agent-` で始まる agent 型 hook の評価役で、2 行の差は 1〜2 秒。
  残る 1 体は claude-code-guide（9 秒差、原因は未調査）。2.1.311 で直った「毎分 2 回」の型ではない
- subagent の `meta.json`（種類と起動の形）と突き合わせたとき、10-24 の 7 体（sweep-db 6・adversarial-verify 1）にも行が無かった。これは issue #906 の
  実測を scratchpad の別ディレクトリで動かしたもので、このリポジトリの hook が読み込まれていない（欠落ではない）

**分かっていないこと**
- web-fetch で欠けるのが「agent の種類」のせいか「foreground という起動の形」のせいか。11 体はすべて foreground で、この版の Agent ツールは
  起動の形を選べないので分けられなかった。旧版では foreground でも Start / Stop が残っている（09-19 の reviewer 30 体・09-18 の judge-panel 1 体・
  10-02 の claude-code-guide 1 体）ので、「foreground なら常に欠ける」ではない
- hook が呼ばれていないのか、呼ばれたが黙って終わったのか。`log-subagent-hook-skeleton.sh` は、Start / Stop の payload で `agent_id` が空だと
  何も書かずに exit 0 する。同じ web-fetch の `PostToolUse(SubagentHandback)` の payload には `agent_id` が入っているので、空である見込みは低いが、
  スクリプトに印を足さないと区別できない（C-025 の型。「行が無い」を「呼ばれていない」と読まない）
  → **同日 測り直し済み（issue #928、PR #929）**: 印を足した版で測り、web-fetch では hook が呼ばれていないと分かった。
  結論と限界は `observability-internals.md` の骨格記録の「既知の限界」
- 読む側への影響。`snapshot-agent-baseline.sh` は Start と Stop の対で実行件数と所要時間を数えるので、web-fetch の実行は載らないはず
  （コードを読んだだけで、出力では確かめていない）。`agentType` が空の行を各スクリプトがどう扱うかは見ていない
  → **同日 確認済み（issue #928）**: 出力に web-fetch の行は無く、`agentType` が空の行は `(unknown)` 1,653 runs として
  数え込まれていた（同上）

**教訓**: 「手元の版」を 1 つの数字で書かない。CLI とデスクトップアプリで本体が別で、後者はアプリ側の更新で進む。記録には
「どの入口の、どの版か」を書き、根拠は transcript の `version` にする。骨格記録を数えるときは `agentType` が空の行を除く。
