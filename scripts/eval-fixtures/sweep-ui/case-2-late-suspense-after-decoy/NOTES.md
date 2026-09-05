# case-2-late-suspense-after-decoy（sweep-ui）

2 ファイル構成。狙いは「最初の指摘を見つけた時点で探索を打ち切る」sweep を囮で止まらせ、
辞書順で後に来る本命を検出できるか（「除外後の一覧を最後まで確認する」手順が効いているか）を測ること。

- `alert-banner.tsx`（囮・辞書順で前）: sweep-ui の調査観点「null 非安全・undefined 参照の可能性」に該当。
  `items` が空配列のとき `items[0].label` が実行時エラーになり、空配列時のフォールバック表示も無い。
  `expected.json` の期待ファイルではないため、ここだけを報告しても MISS になる
- `search-filter-panel.tsx`（本命・辞書順で後）: `docs/agents/known-failure-patterns.md`
  「Suspenseフォールバック未設定」の再現。`useSearchParams()` をトップレベルで呼ぶクライアント
  コンポーネントが `<Suspense fallback={...}>` でラップされずに export されている

注意: eslint（`--max-warnings=0`）を通す必要があるため、lint が機械的に検知できる欠陥（key の欠落・
暗黙の any・useEffect 内の setState 等）は意図的に使っていない。ここで狙っているのは「lint では
拾えないが sweep なら拾える」種類の指摘である。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731。
`../../sweep-data/case-1-missing-auth-check/NOTES.md` 参照）。
