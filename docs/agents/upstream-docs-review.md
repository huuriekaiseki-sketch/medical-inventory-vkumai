# 公式ドキュメント差分の定期確認（upstream docs review）

Claude Code・Anthropic・OpenAI/Codex の公式ドキュメントは数週間単位で更新される（2026-08〜09 の
1 か月で Claude Code は約 20 版）。「業界推奨を網羅したか」は 1 回の調査で決まる状態ではなく、
**定期的に差分を見て、この表と同じ形で判定し直す**作業として持つ。fault-injection 訓練
（[`fault-injection-drill.md`](./fault-injection-drill.md)）と同じ型で、「次回実施予定日」を
SessionStart hook（`scripts/check-upstream-docs-review-staleness.sh`）が監視する。

プラグイン v1（issue #420）の各バージョンで残す「対応する Claude Code・Codex のバージョン」は、
本ファイルの「最後に確認した版」を正本にする。

## 次回実施予定日

2026-10-05（月 1 の目安。Claude Code のマイナー版が 10 個以上進んだとき、または v1 の各バージョン前は
予定日を待たず実施する。実施後に手動で書き換える。期限は SessionStart の個別警告に加え、
`claude -p --maintenance`（`scripts/maintenance-digest.sh`、issue #741）で他の定期作業とまとめて確認できる）

## 最後に確認した版

| 対象 | 版 / 日付 | 確認日 |
|---|---|---|
| Claude Code | 2.1.261（changelog の先頭） | 2026-09-05 |
| Codex CLI | 0.153.4（2026-09-04） | 2026-09-05 |
| Anthropic engineering blog | 最新記事 2026-04-23 | 2026-09-05 |

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
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` が AIDD のモデル階層を無効化するため検知する → issue #743
- `/skill-doctor`（2.1.261）で未使用スキルと context コストを 1 回測る（手動）
- `subagentPromptCacheTtl` / frontmatter `experimental.cacheTtl`（1h）は `/cost` の cache miss 原因を見てから判断

**対応不要**
- `PostCompact` hook: 案 3 は SessionStart(compact) で実装済みで実機動作を確認。移す必要なし
- 2.1.260 の「Workflow subagent が長い compaction 中に stalled 扱いで再起動」修正: check-workflow-interruption の staleness 近似（4 時間）は安全側に動く
- MEMORY.md の上限 200 行 / 25KB: 現状余裕あり
- Codex 0.150 の Interrupt hook: Codex 実機待ちの issue #653 に束ねる

**このセッションで先行して潰した無音死（差分確認と並行の実走ドリル）**: [`hook-live-drill.md`](./hook-live-drill.md) 参照
