# Parallel Subagent Framework

## エージェント構成（クイックリファレンス）

| エージェント | モデル | Phase | 役割 |
|---|---|---|---|
| `sweep-ui` | haiku | Phase 1 | src/app/, src/components/ 調査 |
| `sweep-data` | haiku | Phase 1 | src/lib/supabase/, APIルート調査 |
| `sweep-db` | haiku | Phase 1 | スキーマ・マイグレーション・RLS調査 |
| `sweep-types` | haiku | Phase 1 | 層をまたぐ型整合性調査 |
| `completeness-critic` | sonnet | Phase 1 | 未調査領域検出・ラウンド終了判定 |
| `adversarial-verify` | **opus** | Phase 2 | 指摘への反論で偽陽性除去 |
| `judge-panel` | sonnet | Phase 2 | 3提案の採点・synthesis生成 |
| `implementer` | opus | Phase 3 | TDD実装（RED→GREEN→REFACTOR） |
| `integrator` | sonnet | Phase 4 | 共有ファイル結線・test/lint確認 |
| `reviewer` | sonnet | Phase 5 | 4観点コードレビュー（読み取り専用） |
| `code-reviewer`（汎用） | haiku | 随時 | 汎用コードレビュー |

| ワークフロー | 場所 | Phase | 実行方法 |
|---|---|---|---|
| `aidd-phase1` | `.claude/workflows/` | Phase 1 | `Workflow({ scriptPath: '.claude/workflows/aidd-phase1.js', args: { taskDescription: '...' } })` |
| `aidd-impl` | `.claude/workflows/` | Phase 3-5 | `Workflow({ scriptPath: '.claude/workflows/aidd-impl.js', args: { specContent: '...', parallelGroups: [...] } })` |
| `spec-deep-validate` | `~/.claude/workflows/` | Phase 2（条件付き） | `Workflow({ name: 'spec-deep-validate', args: { specContent: '...', specPath: 'SPEC.md' } })` |

| スキル | 場所 | Phase |
|---|---|---|
| `feature-spec` | `.claude/skills/` | Phase 2 仕様書生成 |
| `structured-review` | `.claude/skills/` | Phase 5 後・人間起動 |
| `e2e-runner` | `.claude/skills/` | 随時 |

→ 全体マップ: [`docs/ai-config-map.md`](docs/ai-config-map.md)

## プロジェクト設定
- テストコマンド: npm test
- Lintコマンド:   npm run lint
- UIディレクトリ: src/app/ / src/components/ / データ取得: src/lib/supabase/ / DB: Supabase (PostgreSQL)

## フロー（骨格）
Phase 1 調査(並列) → Phase 2 仕様書(並列グループ宣言) → [停止① 人間レビュー] → Phase 3 実装(TDD・並列) → Phase 4 統合ゲート → Phase 5 検証(並列) → [停止② 構造化レビュー]

## どのフェーズでどのスキルを呼ぶか
- Phase 2（仕様書）→ skill「feature-spec」を使う
- E2E・スクショが必要なとき（随時・フロー外）→ skill「e2e-runner」を使う
- Phase 5（検証）のあと → ユーザーに /structured-review を促して停止する

## Phase 2 仕様書の深層検証（条件付き）
以下のいずれかに該当する場合、feature-spec で SPEC.md を生成した**後**に
workflow「spec-deep-validate」を実行して仕様書を検証してから停止①に入ること。

- 設計が複雑（複数テーブル・複数レイヤーにまたがる）
- DBスキーマ変更・マイグレーションを含む
- リスクが高い（認証・認可・課金・外部連携など）

実行方法（args.specContent に SPEC.md の内容を渡す）:
```
Workflow({ name: 'spec-deep-validate', args: { specContent: '...', specPath: 'SPEC.md' } })
```

ワークフローの出力（synthesis）を仕様書修正に反映してから停止①でレビューを求めること。

## 絶対ルール
- 確認を求めるのは「仕様レビュー（停止①）」と「構造化レビュー（停止②）」の2箇所のみ。
- それ以外は止まらず自律的に進める。
- 停止①：仕様書を提示したら、人間が承認するまで Phase 3（実装）へ進まないこと。
- 停止②：構造化レビューは `/structured-review` で人間が起動するまで勝手に実行しないこと。

## Phase 1: 調査（Multimodal Sweep + Loop Until Dry + Completeness Critic）

### Sweep対象（全軸共通）
バグ・型安全性 / DB設計・整合性 / セキュリティ / アーキテクチャ整合性

### 実行方法
**`aidd-phase1` ワークフローで自動実行する。**

```js
Workflow({
  scriptPath: '.claude/workflows/aidd-phase1.js',
  args: { taskDescription: '（タスクの説明）' }
})
```

内部動作（参考）：
- **Step 1: Multimodal Sweep（4軸・並列）** — `sweep-ui` / `sweep-data` / `sweep-db` / `sweep-types` を同時起動。各報告は箇条書きのみ。
- **Step 2: Loop Until Dry** — 各ラウンド末に `completeness-critic` を起動。「追加調査対象:」を返せば次ラウンドへ、「新規指摘なし」が2回連続で終了（最大3ラウンド）。

## Phase 2: 仕様書（skill「feature-spec」を使う）
調査結果を skill「feature-spec」で SPEC.md にまとめる（2部構成＋並列グループ宣言）。
- 人間には Part 1 だけ提示し、Part 2 は「技術詳細なのでレビュー不要」と伝える。
- 【停止①】仕様書を提示したら、人間が承認するまで Phase 3 に進まないこと。

## Phase 3-5: 実装・統合・検証
**仕様書承認（停止①）後、`aidd-impl` ワークフローで自動実行する。**

```js
Workflow({
  scriptPath: '.claude/workflows/aidd-impl.js',
  args: {
    specContent: '（SPEC.md の全文）',
    parallelGroups: [
      { name: 'グループA', description: '担当範囲の説明' },
      { name: 'グループB', description: '担当範囲の説明' },
    ]
  }
})
```

内部動作（参考）：
- **Phase 3: 実装** — `implementer` を並列グループ数だけ同時起動。各自 RED→GREEN→REFACTOR。共有ファイルは触らない。
- **Phase 4: 統合ゲート** — `integrator` が共有ファイルを結線。`npm test` + `npm run lint` で緑を確認。
- **Phase 5: 検証** — `reviewer` を4観点（正しさ・仕様カバレッジ・重複・型安全）で並列起動。指摘のみ返す。その結果を持って `/structured-review` へ。

## サーキットブレーカー
- フロー開始時に `/goal` を1回セットしてから自走に入る（条件の書き方は下記）。
- 完了条件はタイトに（曖昧な条件は無限ループの燃料）
- `/goal` の条件に**ターンまたは時間の上限を条件文として**含める（例：「or stop after 20 turns」）
- Autoモードで全ツールを無条件承認しない
- テスト修正は1セット3回まで（局所上限）
- フロー全体の上限も必ず持つ（局所上限だけでは財布を守れない）
