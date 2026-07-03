# Loop Observability（ステップアップ版）設計

**日付:** 2026-07-02
**スコープ:** Step 0 — ログの置き場所・フォーマット合意のみ（実装はStep 1以降で段階着手）

---

## 背景・目的

Loop Engineering（Agentic coding loop / Developer feedback loop / External feedback loop）のうち、Agentic coding loop（実装エージェントの自己修正ループ）が現状ブラックボックス化している。既存の自己修正ループ・レビュー判断・E2E結果を1つのログに可視化し、人間が読める要約に変換することで、モデル選定やコストの妥当性を後から検証できるようにする。

新機能を作るのではなく、既にある挙動（implementer.mdの自己修正ループ、reviewer.md/judge-panel.mdの判断、Playwright結果）を可視化するだけに留める。

---

## スコープ

**対象（Step 0で合意する範囲）:** ログの置き場所・スキーマ・段階移行方針
**対象外（Step 1以降で個別着手）:** 各エージェント定義への書き込み指示追加、要約変換コマンド、MCP連携ログ

---

## ログの置き場所

`logs/loop-observability.jsonl`（1行1レコードのJSON Lines）

---

## スキーマ

```json
{
  "timestamp": "2026-07-02T13:42:00+09:00",
  "loop": "agentic",
  "agent": "implementer",
  "feature": "admin-role",
  "attempt": 1,
  "model": "sonnet",
  "tokens": null,
  "costUsd": null,
  "intent": "...",
  "scenario": "...",
  "result": "pass",
  "reason": "..."
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `timestamp` | string | ISO 8601 |
| `loop` | `"agentic"` \| `"developer"` \| `"external"` | どのループのレコードか |
| `agent` | string | 下記「agentフィールドの値域ルール」参照 |
| `feature` | string | 対象機能名（例: `admin-role`） |
| `attempt` | number | 同一featureでの試行回数 |
| `model` | string \| null | 実行モデル名。第一段階は自己申告（下記参照） |
| `tokens` | number \| null | 第一段階は常にnull。第二段階でtranscript集計により後付け更新 |
| `costUsd` | number \| null | 同上 |
| `intent` | string | 何をしようとした試行か |
| `scenario` | string | 検証したシナリオ |
| `result` | `"pass"` \| `"fail"` \| その他判断結果 | 結果 |
| `reason` | string | 結果の理由 |

---

## agentフィールドの値域ルール（重要）

`loop: "developer"` のレコードでは、人間（開発者）とAIエージェントの両方が `agent` フィールドに値を書きうる。両者を区別できないと、Developer feedback loop（人間がAgentic coding loopの成果を判断するループ）にAIの自己レビューが紛れ込み、ループの意味が薄まる。

**ルール:** `agent` の値域を3つに分離する。

- **人間の場合:** 固定文字列 `"human"` を使う（個人名は書かない。Gitのコミッターと違いログは長期蓄積されるため、実名を値として繰り返し書き込む設計にしない）。**必ず人間が実際に判断を下した記録にのみ使う**（CI・自動実行の既定値として流用しない）
- **AIエージェントの場合:** `.claude/agents/` のagent定義名をそのまま使う（例: `implementer`, `reviewer`, `judge-panel`）
- **判断を伴わない機械的自動実行の場合:** `"e2e-runner"` のような専用の固定値を使う（例: Playwrightをローカル手動実行・CI無人実行のどちらで走らせても、実行主体を明示的に指定していない限りこの値を使う）。CI実行かローカル手動実行かの区別は `agent` ではなく `reason` に書く

この3つの値域は文字列としても重複しないため、後続の集計・要約スクリプトは `agent === "human"` かどうかだけで「人間が実際に判断したレコード」を判定できる（`e2e-runner` はAIの自己レビューにも人間の判断にも該当しないため、`human`側にもAI側にも混入しない）。

---

## 段階移行方針

### 第一段階（Step 1〜4で実装）
- `model` のみ自己申告（エージェント定義に「自分のモデル名を記録」と指示を追加）
- `tokens` / `costUsd` は常に `null`
- 理由: サブエージェントは自分が消費した正確なトークン数・コストをプロンプト内から把握できない。自己申告させても不正確な値になるだけなので、第一段階では書かせない

### 第二段階（Step 7・任意、落ち着いてから着手）
- `~/.claude/projects/` 配下のtranscript jsonl（実際のusageが記録済み）から集計するスクリプトを追加
- `timestamp` + `agent` + `attempt` をキーに該当レコードを特定し、`tokens` / `costUsd` を後付けで更新
- 既存レコードのスキーマ（フィールド構成）は変更しない。値の埋め込みのみ行う

---

## ステップアップ計画（既存合意の再掲）

| Step | やること | 触るファイル |
|---|---|---|
| 0 | 本設計の合意（このドキュメント） | なし |
| 1 | implementer.mdの自己修正ループに1試行1レコード書き出し指示を追加（`model`含む） | `.claude/agents/implementer.md` |
| 2 | reviewer.md/judge-panel.mdに判断記録の指示を追加 | `.claude/agents/reviewer.md`, `judge-panel.md` |
| 3 | Playwright実行結果をログに紐付け | `playwright.config.ts` or e2e側 |
| 4 | 溜まったログを人間が読める要約に変換するコマンド/スクリプトを作る | 新規スクリプト |
| 5（任意・MCP） | implementerのブラウザ確認箇所でPlaywright MCPを使わせ、利用ログも記録（完了・2026-07-03） | `.mcp.json`, `.claude/agents/implementer.md` |
| 6（任意・MCP） | 実装前にContext7 MCPで最新ドキュメント参照させ、参照有無をログに残す（縮小版で完了・2026-07-03。`resolve-library-id`のみ利用。`query-docs`はサブエージェントのツール可視性制約〔deferredツールをロードする`ToolSearch`がサブエージェントに提供されない〕により保留、環境側の仕様変更後に再挑戦） | `.mcp.json`, `.claude/agents/implementer.md` |
| 7（任意・後日） | transcript集計スクリプトで`tokens`/`costUsd`を後付け更新（第二段階） | 新規スクリプト |

---

## 将来的な拡張（スコープ外）

- ログのDB化・外部サービス送信
- コストダッシュボード化
- モデル選定の自動最適化（ログを元にした推奨）
