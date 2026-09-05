# case-1-missing-auth-check（sweep-data）

埋め込んでいる欠陥: `docs/agents/known-failure-patterns.md`「動いたからOKでfacility_idフィルタ漏れ・RLS未設定を見逃す」（issue #24再発防止）の再現。`requireAuth` / `requireFacilityAccess` による認可チェックが一切無いまま、パスパラメータの `id` をそのまま DB クエリに渡している。

**この説明を `files/` 配下のコードにコメントとして書かないこと。** 2026-09-05 の切り分け（issue #731）で、
コード先頭に「issue #431 の recall ベンチマーク用 fixture。○○を意図的に再現」と書いてあると、
sweep エージェントが欠陥に気づいた上で「意図的な fixture」と判断して指摘から外し（生出力に
「すべての API ルート（eval-fixture-recall を除く）に requireAuth が実装されている」と書いた）、
MISS になることを実測した。コメントを外すと同じ定義・同じモデルで HIT した。
`scripts/check-eval-fixtures-neutral.test.sh` が `files/` 配下に自己申告語が無いことを機械検査する。
