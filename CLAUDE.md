# Parallel Subagent Framework

## エージェント構成（クイックリファレンス）

| エージェント | 場所 | モデル | Phase |
|---|---|---|---|
| `implementer` | `.claude/agents/` | opus | Phase 3 実装 |
| `reviewer` | `.claude/agents/` | sonnet | Phase 5 検証 |
| `code-reviewer`（汎用） | `~/.claude/agents/` | haiku | 随時 |

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

### Step 1: Multimodal Sweep（4軸・並列）
以下の4軸を、それぞれ独立したサブエージェントで**同時起動**する。各報告は**箇条書きのみ**。コードは書くな。

1. **UI層** — `src/app/` / `src/components/` を調査。コンポーネント・props型・state・イベントハンドラ。null非安全・型エラー・バグ・設計違反を報告。
2. **データ取得層** — `src/lib/supabase/` を調査。APIエンドポイント・hooks・型定義。型エラー・セキュリティ問題・設計違反を報告。
3. **DB層** — Supabase スキーマ・マイグレーション・RLSを調査。整合性・設計問題・セキュリティ問題を報告。
4. **型整合性** — 型定義 vs mappers vs DB列 vs UI props を縦断調査。層をまたぐ型の不一致・欠落を報告。

### Step 2: Loop Until Dry（Completeness Critic を各ラウンド末に実行）
各ラウンドの末尾で Criticエージェントを1体起動し、「未調査のモダリティ・未検証のクレーム・未読のソースはあるか？」を問う。
Criticが新たな調査対象を返した場合、次ラウンドの Sweep に追加する。

終了条件：**Sweep の新規発見 = 0 かつ Critic の新規指摘 = 0** が2ラウンド連続で続いたら終了（最大3ラウンド）。

## Phase 2: 仕様書（skill「feature-spec」を使う）
調査結果を skill「feature-spec」で SPEC.md にまとめる（2部構成＋並列グループ宣言）。
- 人間には Part 1 だけ提示し、Part 2 は「技術詳細なのでレビュー不要」と伝える。
- 【停止①】仕様書を提示したら、人間が承認するまで Phase 3 に進まないこと。

## Phase 3: 実装（TDD・並列）
仕様書 Part 2 の「並列グループ」ごとに implementer を同時起動。各自 RED→GREEN→REFACTOR。
- 各セットは自分のファイルと自分のテストだけを書く（共有ファイルは触らない）。
- ファイル独立が明確なら worktree 不要。怪しければ別 worktree で隔離。
- 依存するセットは次の波へ（依存順は仕様書が宣言）。

## Phase 4: 統合ゲート（並列実装の後に必ず1枚・親が逐次で）
- 親（または1体の implementer）が各セットの成果を結線する（共有ファイルを触るのはここだけ）。
- 全テスト＋lintを回して緑を確認。競合・重複・宣言外のファイル変更がないか確認。

## Phase 5: 検証を観点ごとに並列実行（読み取り専用・停止②の前）
テスト・lintが緑になったら、reviewer を次元ごとに並列起動する（読むだけなので衝突しない）。
- 正しさ（バグ・境界条件）
- 仕様カバレッジ（受け入れ条件 vs 実装・テスト）
- 重複・過剰実装・抜け漏れ
- 型安全・データ層の整合

各レビュアーは箇条書きで指摘のみを返す。修正可否は親が判断（自動修正しない）。その指摘を持って /structured-review へ。

## サーキットブレーカー
- フロー開始時に `/goal` を1回セットしてから自走に入る（条件の書き方は下記）。
- 完了条件はタイトに（曖昧な条件は無限ループの燃料）
- `/goal` の条件に**ターンまたは時間の上限を条件文として**含める（例：「or stop after 20 turns」）
- Autoモードで全ツールを無条件承認しない
- テスト修正は1セット3回まで（局所上限）
- フロー全体の上限も必ず持つ（局所上限だけでは財布を守れない）
