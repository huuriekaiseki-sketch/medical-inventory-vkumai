# 陰性対照（sweep-types）

## 何を測るか

**欠陥が無いコードに指摘を出さないこと**（誤警報率）。

case-1（`shift-handovers`）は型定義に `internalNote` が無いのに mapper が返しており、
`@ts-expect-error` で潰していた。こちらは同じ形で、型・行・mapper が 1 対 1 に対応している。

## 判定

`expectNoFinding: true`。この 2 ファイルのどちらかを名指しし、かつ `internalNote` /
`internal_note` / `WardSupplyItem` に触れた**指摘**を出したら過検出。

## 限界

「もっと厳しい型にできる」といった改善提案も、パスとキーワードに結びつけば過検出として数える。
陰性対照は「欠陥が無い」ことを測るもので、「改善余地が無い」ことは測らない。
