# 公式ドキュメント差分の定期確認（upstream docs review）

Claude Code・Anthropic・OpenAI/Codex の公式ドキュメントは数週間単位で更新される（2026-08〜09 の
1 か月で Claude Code は約 20 版）。「業界推奨を網羅したか」は 1 回の調査で決まる状態ではなく、
**定期的に差分を見て、この表と同じ形で判定し直す**作業として持つ。fault-injection 訓練
（[`fault-injection-drill.md`](./fault-injection-drill.md)）と同じ型で、「次回実施予定日」を
SessionStart hook（`scripts/check-upstream-docs-review-staleness.sh`）が監視する。

プラグイン v1（issue #420）の各バージョンで残す「対応する Claude Code・Codex のバージョン」は、
本ファイルの「最後に確認した版」を正本にする。

## 次回実施予定日

2026-11-23（月 1 の目安。Claude Code のマイナー版が 10 個以上進んだとき、または v1 の各バージョン前は
予定日を待たず実施する。実施後に手動で書き換える。期限は SessionStart の個別警告に加え、
`claude -p --maintenance`（`scripts/maintenance-digest.sh`、issue #741）で他の定期作業とまとめて確認できる）

## 最後に確認した版

| 対象 | 版 / 日付 | 確認日 |
|---|---|---|
| Claude Code | 2.1.309（changelog の先頭。手元は 2.1.289 で 20 版遅れ） | 2026-10-23 |
| Codex CLI | 0.163.0（2026-10-15。0.164 は alpha のみ） | 2026-10-23 |
| Anthropic engineering blog | 最新記事 2026-10-13（claude.com / claude.dev 側の実践記事は 2026-10-22 まで確認） | 2026-10-23 |

## 手順（1〜2 時間）

1. **差分を取る**（WebFetch で要約。日付でフィルタさせると要約器が誤るので「先頭から N 版」で取る）
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
