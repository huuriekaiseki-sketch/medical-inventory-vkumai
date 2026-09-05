# case-1-security-definer-bypass（sweep-db）

埋め込んでいる欠陥: `docs/agents/known-failure-patterns.md`「SECURITY DEFINER + GRANT EXECUTEの認可バイパス」の再現。
`SECURITY DEFINER` 関数が `is_facility_member` / `is_admin` による明示的な認可チェックを一切行わないまま、
施設に紐づく機微データ（`internal_note`）を返し、`GRANT EXECUTE` で `anon` にも実行権限を与えている。

テーブル自体は意図する欠陥（認可チェック欠落）とは無関係だが、参照先テーブルも定義している
（「テーブル未定義」という別の欠陥に注目が逸れないようにするため）。

**この説明を `files/` 配下のコードにコメントとして書かないこと**（issue #731。
`../../sweep-data/case-1-missing-auth-check/NOTES.md` 参照）。
