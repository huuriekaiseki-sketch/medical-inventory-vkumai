# case-2-negative-control（sweep-data）

**陰性対照**（2026-09-10、レビュー指摘 R11）。埋め込んでいる欠陥は**無い**。
`requireAuth` → 取得 → `requireFacilityAccess` の順で認可を掛けた、正しい書き方の route を置く。

## なぜ要るか

recall（見つけられた割合）を陽性の fixture だけで測ると、**「全部に指摘を出す」エージェントが満点**になる。
実際、2026-09-10 まで採点器は「期待パスの部分文字列 AND 期待キーワード」しか見ておらず、
「route.ts を確認しましたが問題はありません」という**見逃しの回答**も HIT になっていた。
陽性だけでは、採点器が甘くなったことにも、エージェントが過検出になったことにも気づけない。

この case は `expected.json` に `expectNoFinding: true` を持ち、**何も指摘しなければ HIT**、
**指摘を出したら MISS** と逆向きに採点される（`scripts/lib/judge-sweep-recall.py`）。

## 限界

- 「指摘 0 件」の判定は出力契約（`FINDINGS: <件数>` の行、または「指摘なし」の語）に依存する。
  契約を外した書き方をされると「指摘あり」に倒れる（安全側だが、この case では MISS になる）。
- この route が本当に安全かどうかは、ここでは測っていない（測っているのは
  **エージェントが誤って指摘を出さないか**）。実際の認可の強さは RLS の変異計測と攻撃表が見る。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（case-1 の NOTES.md 参照。
`scripts/check-eval-fixtures-neutral.test.sh` が機械検査する）。
