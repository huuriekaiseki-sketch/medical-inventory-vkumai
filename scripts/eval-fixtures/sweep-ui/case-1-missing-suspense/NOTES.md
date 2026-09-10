# case-1-missing-suspense（sweep-ui）

埋め込んでいる欠陥: `docs/agents/known-failure-patterns.md`「Suspenseフォールバック未設定」の再現。
`useSearchParams()` を使うクライアントコンポーネントが `<Suspense fallback={...}>` でラップされずに
export されている。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731。
`../../sweep-data/case-1-missing-auth-check/NOTES.md` 参照）。

## ほかに何が捕まえるか: **next build は落とさなかった**（2026-09-10 実測）

公式文書は「静的ページなら build が落ちる」と書いているが、
**このアプリは全ルートが動的レンダリングなので適用されない**。
Suspense 無しのページを置いて `npm run build` を回したら**成功した**（終了コード 0）。

lint も落とさない。**LLM もフレームワークも lint も捕まえていなかった。**

→ `scripts/check-suspense-gaps.test.sh` を新設して塞いだ（この fixture を入力に使って検知を固定）。
