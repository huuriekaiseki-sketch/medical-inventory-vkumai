# AgentResult 共通スキーマ

AIDDワークフロー（`.claude/workflows/`）の`agent()`呼び出しが、成否を機械判定できるようにするための共通スキーマ。対応issue: #41

## 型定義

```
AgentResult = {
  status: 'pass' | 'fail' | 'blocked',
  detail: string   // 人間可読の要約(自由記述文字列)
}
```

- `pass`: 完遂できた（内容の良し悪しは`detail`で表現する）
- `fail`: 完遂を試みたが、成果物が要件を満たさない
- `blocked`: 前提条件が欠けており着手・完遂できなかった
- 呼び出し種別によっては`fail`が存在しない設計のものがある（下記参照）

## 判定基準（agent呼び出しごと）

### `aidd-phase1.js`

| 呼び出し (L28-33) | pass | fail | blocked |
|---|---|---|---|
| sweep-ui / sweep-data / sweep-db / sweep-types | 調査を最後まで実行できた（指摘の有無は問わない） | 該当なし（調査系エージェントに「失敗」概念は無い） | 権限不足・対象コード不在等で調査そのものが実行できなかった |

### `aidd-phase2.js`

| 呼び出し | pass | fail | blocked |
|---|---|---|---|
| contract-writer | 型定義・APIインターフェース型を確定できた | 型定義を試みたが不完全・矛盾がある | SPEC.mdが存在しない/読めない |
| db-impl | マイグレーション実装が完了した | マイグレーションを試みたがエラー・矛盾がある | SPEC.mdが存在しない、またはPart2にマイグレーション情報が無く着手不能 |
| data-impl / api-impl / ui-impl | 担当範囲の実装を完了できた | 実装したが明らかに不完全、またはcontract-writer/db-implの結果と矛盾する | SPEC.mdが見つからない、またはcontract-writer/db-implの完了報告が空で着手できなかった |
| integrator | npm test・npm run lintが最終的に緑で統合完了 | 3回の修正試行後もtest/lintが赤のまま | SPEC.mdが見つからない、またはいずれかのimplエージェントの完了報告に「仕様書が見つからない」「作業を開始できない」旨の記述がある |
| review:correctness / coverage / redundancy / type-safety | レビューを完了し指摘なし | レビューを完了し1件以上の指摘がある | レビュー対象のコード・SPEC.mdが見つからずレビュー自体ができなかった |

### `aidd-1-1-deep-task.js`

9系統のagent呼び出しのうち、status追加対象は4系統のみ。残り5系統は既存のドメイン固有schema（severity/refuted/gaps/score等）で完結しており、汎用statusを読む消費先が本ファイル内に存在しないため対象外とする。

| # | 呼び出し | status追加 | pass | fail | blocked |
|---|---|---|---|---|---|
| 1 | sweep-ui/data/db/types（4本） | 対象 | 調査完了(指摘有無問わず) | 該当なし | 調査不能 |
| 2 | completeness-critic 1周目 | 対象 | 批評を完了した(追加調査の要否は問わない) | 該当なし | Sweep結果が空で批評に着手できなかった |
| 3 | draft-spec | 対象 | 仕様書ドラフトを生成できた | 生成されたが調査結果を反映していない等明らかに不完全 | Sweep結果が空でドラフト生成に着手できなかった |
| 4 | find（lens×5） | 対象外 | — | — | — |
| 5 | verify (Adversarial Verify) | 対象外 | — | — | — |
| 6 | completeness-critic 2周目 | 対象外 | — | — | — |
| 7 | propose（stance×3） | 対象外 | — | — | — |
| 8 | score（lens×3×proposal数） | 対象外 | — | — | — |
| 9 | synthesize | 対象 | 統合提案を生成できた | 必須修正等のセクションが欠落するなど明らかに不完全 | survived/gaps/winnerのいずれかが揃わず統合に着手できなかった |

## 集計ロジックの原則（2軸分離）

`status`は「エージェントが完遂できたか」を表す軸であり、「指摘・findingsの有無」を表す軸とは別である。この2つを混同すると、たとえば調査系（sweep/critic）のように`fail`を返さない設計のエージェントでは、`status`だけを見てもfindings件数を正しく数えられない。

- 完遂したかどうか（ゲート・observability用）→ `status`
- 何を見つけたか（セッションレポートの件数指標用）→ `detail`の内容（例: `status === 'pass' && detail !== '指摘なし'`）

両者を必要に応じて組み合わせて使う（例: `aidd-phase1.js`の`findingCount`は両方を参照する）。
