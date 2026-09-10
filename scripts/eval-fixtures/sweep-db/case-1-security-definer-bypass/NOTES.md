# case-1-security-definer-bypass（sweep-db）

埋め込んでいる欠陥: `docs/agents/known-failure-patterns.md`「SECURITY DEFINER + GRANT EXECUTEの認可バイパス」の再現。
`SECURITY DEFINER` 関数が `is_facility_member` / `is_admin` による明示的な認可チェックを一切行わないまま、
施設に紐づく機微データ（`internal_note`）を返し、`GRANT EXECUTE` で `anon` にも実行権限を与えている。

テーブル自体は意図する欠陥（認可チェック欠落）とは無関係だが、参照先テーブルも定義している
（「テーブル未定義」という別の欠陥に注目が逸れないようにするため）。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731。
`../../sweep-data/case-1-missing-auth-check/NOTES.md` 参照）。

## 実測: この欠陥は 3 回とも見逃された（2026-09-10）

同じ条件（`workflowsTree` 9b1dd253 / `fixturesTree` fceade51 / モデル haiku）で 3 回回した結果:

| 回 | 結果 | 所要 | 費用 |
| --- | --- | --- | --- |
| 08:19:29Z | MISS | 176 秒 | $0.4918 |
| 08:24:29Z | MISS | 166 秒 | $0.3327 |
| 08:27 頃   | MISS | — | — |

**0 / 1 が 3 回。幅 0 ポイントで「安定した見逃し」。** 揺れではない。

### 採点器の読み違えではない（生出力で確認）

3 回目の生出力（`EVAL_SWEEP_RECALL_DEBUG_DIR` で保存）を読んだところ、エージェントは
`FINDINGS: 0` / `指摘なし` を返し、しかも報告の中で

> 2. **SECURITY DEFINER 関数の認可チェック**（既知の失敗パターン）
>    ✓ …… is_admin() チェック実装
>    ✓ …… facility チェック実装

と、**この欠陥があるカテゴリそのものを合格として報告**していた。

さらに「supabase/migrations/ ファイル数：**73件を全件検査**」と申告しているが、
エージェントが見ていた clone の migration は **85 件**（実リポジトリ 84 + この fixture 1）。
**件数の自己申告そのものが実態と違う。**

### ここから読めること

- Sweep の「全件検査しました」という自己申告は、件数すら当てにならない
- 見逃し率を測る土台（この fixture）は正しく働いている。**測って初めて分かった**
- 直し方は fixture 側ではなく Sweep 側（プロンプト・モデル・探索の方法）にある。
  ここは次の課題として残す（この NOTES は「測った事実」を残す場所であって、
  直したことにする場所ではない）

限界: 3 回はモデルの揺れを見るには少ない。別のモデル・別の日で同じかは測っていない。
