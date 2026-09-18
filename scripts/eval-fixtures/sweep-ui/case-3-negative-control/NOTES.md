# 陰性対照（sweep-ui）

## 何を測るか

**欠陥が無いコードに指摘を出さないこと**（誤警報率）。

case-1（`shift-handovers/page.tsx`）は `useSearchParams` を `Suspense` の外で呼んでいた。
こちらは同じ話題で、正しく書いてある:

- `useSearchParams` を使うのは client component（`filter.tsx`）だけ
- ページ側はその component を `<Suspense fallback=...>` で囲む

## 判定

`expectNoFinding: true`。この 2 ファイルのどちらかを名指しし、かつ `Suspense` /
`useSearchParams` に触れた**指摘**を出したら過検出。

## 限界

case-2（囮のあとに正しく Suspense がある）と紛らわしい。case-2 は**別の場所に本物の欠陥がある**
陽性で、こちらは**どこにも欠陥が無い**陰性。両方あることで「囮に釣られる」と
「正しいものに指摘を出す」を区別できる。
