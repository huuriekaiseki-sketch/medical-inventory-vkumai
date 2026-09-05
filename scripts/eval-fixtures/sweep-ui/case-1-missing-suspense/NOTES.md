# case-1-missing-suspense（sweep-ui）

埋め込んでいる欠陥: `docs/agents/known-failure-patterns.md`「Suspenseフォールバック未設定」の再現。
`useSearchParams()` を使うクライアントコンポーネントが `<Suspense fallback={...}>` でラップされずに
export されている。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731。
`../../sweep-data/case-1-missing-auth-check/NOTES.md` 参照）。
