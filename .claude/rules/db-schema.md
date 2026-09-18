---
paths:
  - "supabase/migrations/**"
---

# DBスキーマ変更ルール

- **新しいテーブルを作る前に、[`../../docs/agents/design-questions.md`](../../docs/agents/design-questions.md) の質問を人に聞く。**
  大きさ（文字数・件数）・量（何回まで）・権限（誰が読み書きするか）・消えるとき・記録・途中で止まったとき・
  外部送信の 7 つ。**分からない値を勝手に既定値で埋めない**（2026-09-07 にそれをやって、後から
  migration をもう 1 本書き直した）。聞いた答えは migration の先頭に `-- design:` で残し、
  `scripts/check-design-questions.test.sh`（CI `hooks-test`）が記録の有無を検査する

- **新しいテーブルを作るときは 4 軸すべてを決める（2026-09-07）。**
  (1) RLS を有効にするか  (2) ポリシーを作るか  (3) **誰が読み書きできるか**  (4) 監査対象にするか。
  決めた内容は [`docs/agents/table-rulebook.md`](../../docs/agents/table-rulebook.md)（TB-xxx）に 1 行書く。
  **決めごとの正本はこの 1 枚だけ**で、`rls_enabled_all_tables` も `audit_trigger_coverage` も
  ここを読む（同じ判断を 2 か所に置かない）。書かないと
  `supabase/migrations/__tests__/table_registry.test.ts` が「宣言が無い」で落ちる
  （`npm test` に含まれるので毎 PR）。宣言と migration の実態がずれても落ちる。
  表の**形**は汎用エンジン `scripts/lib/check-catalog.mjs` が見る（登録は `scripts/lib/catalog-registry.json`、
  索引は [`docs/agents/rulebooks.md`](../../docs/agents/rulebooks.md)）。
  - 特に (3) は 2026-09-07 まで**どの検査も見ていなかった**。その結果 `schema_drift_log` は
    作られてから 2 か月間 GRANT が 1 行も無く、service_role でも読めなかった。
    RLS のバイパス（service_role）とテーブル権限は別の話で、**GRANT を書かなければ誰も読めない**
  - **`REVOKE ALL ON TABLE <t> FROM PUBLIC, anon, authenticated, service_role;` を先に書いてから
    必要な GRANT だけを書く**。Supabase の既定権限（`ALTER DEFAULT PRIVILEGES`）が効くかは
    環境で変わり、実測でも効いている表と効いていない表の両方があった。既定に答えを委ねない
  - ポリシーを作らない表（SECURITY DEFINER 関数からしか触らない表）は、
    **実 DB で「読める人・読めない人」を測る統合テスト**も必須（静的検査は GRANT の文字列しか見られない）

- **関数を書き直すときは「最後に定義した版」を元にする（2026-09-08・E-064）。**
  `CREATE OR REPLACE FUNCTION` は本文をまるごと差し替えるので、**古い版を元に書くと
  後から入った強化が黙って消える**。同じ関数が何本もの migration で再定義されているのが普通で、
  最初の版に `has_aal2()` や `SET search_path` が入っていないことは珍しくない。
  - 実際に 2026-09-08、`get_order_amount_report` を最初の版（20260715000003）を元に書き直し、
    20260907000001 で足してあった `has_aal2()` の判定を消した。
    **パスワードだけを奪われた admin が全施設の金額を読める状態**に戻っていた
  - 書き直す前に `grep -rn "FUNCTION <名前>" supabase/migrations` で**全部の再定義を並べ、
    いちばん新しいものを開く**。最初の 1 本ではない
  - 再定義で認可の判定（`is_admin()` / `has_aal2()` / `is_facility_member()` /
    `is_facility_writer()` / `SET search_path`）が消えると
    `scripts/check-guard-regressions.test.sh`（CI `hooks-test`）が落とす。
    狭める変更（`is_facility_member` → `is_facility_writer`）は違反にしない。
    意図して外すときは migration に `-- drops-guard: <理由>` を書く（理由は同じ行に必須）
  - **この検査は名前があるかどうかしか見ない。** `IF NOT is_admin() THEN` を `IF true THEN` に
    すれば素通りする。それは RLS 変異計測（`scripts/check-rls-mutation.sh`）の担当

- **新しい「操作」（表 × 動詞）を足すときは、先に契約を 1 行書く（2026-09-09）。**
  決める単位は表ではなく**操作**。`GRANT ALL` は 3 文字で 4 動詞を開くので、表単位で決めていると
  **誰も決めていない権限**が積み上がる（実測: 3 か月で 20 件。E-056 / E-057）。
  - [`docs/agents/operation-contracts.md`](../../docs/agents/operation-contracts.md)（O-xxx）に
    1 行足す。決めるのは 4 つ: **入口**（route か RPC か）／**直接書き込み**（許可 / 禁止）／
    **認可**（誰に）／**危険度**。
  - `禁止` にしたらクライアント権限を与えない（作成は SECURITY DEFINER の RPC だけにする）。
    `許可` にしたら **GRANT とポリシーをその動詞だけ**に付ける（`GRANT ALL` / `FOR ALL` にしない）。
  - `scripts/lib/check-operation-contracts.mjs`（CI `hooks-test`）が宣言と実態を**両方向**で突き合わせる:
    権限があるのに行が無い／行があるのに権限が無い／`禁止` なのに権限がある／`禁止` なのにアプリが
    直接書いている／入口の route・RPC が実在しない／route が攻撃表に載っていない。
  - **見ていないもの**: 認可の列（「施設 writer + aal2」）とポリシー本文の一致。
    route の中で認可を呼んでいるか（それは攻撃表 P-017 と RLS の変異計測の担当）。

- **`SECURITY DEFINER` の RPC が行 ID を受け取るなら、参照先の持ち主を必ず確かめる（2026-09-09）。**
  通常の表操作は RLS が施設境界を見るが、**`SECURITY DEFINER` は RLS を通らない**。
  つまり RPC を 1 本書くたびに「この引数の ID は呼び出し元の施設のものか」を関数内で書く必要がある。
  これを書き忘れる形を **混乱した代理人（confused deputy）** と呼ぶ——呼び出し元は正しく認証・認可
  されていて、**渡された参照先だけ**が他人のもの。1 日で 2 件出た（I-035 / I-036）。
  - **自分で書かない。** `assert_facility_owns(施設ID, 種別, ID の配列 [, 親の ID])` を呼ぶ
    （20260909080000）。種別は閉じた語彙で、知らない語を渡すと**通さずに落ちる**。
    新しい参照先を足すときはこの関数に種別を 1 つ足す（実装を増やさない）。
  - **`p_items` のような JSONB の中の ID も対象**。関数の署名からは見えないので、
    型から自動で見つける仕組みは作れない（作ると「ID 引数 0 件」で緑になる。C-040）。
  - **総当たりの登録簿に 1 行足す**:
    `supabase/__tests__/integration/rpc-reference-boundary.integration.test.ts`。
    参照先を受けるなら攻撃の引数を、受けないなら**理由**（15 文字以上）を書く。
    公開 RPC が全部登録されているかは同じテストの ratchet が見るので、**書き忘れると落ちる**。
  - 測るのは必ず**両方向**。他施設の ID で拒否されること、**自施設の ID なら通ること**（C-021）。
  - アプリ層（repository）にも同じ確認を置いてよいが、**それは防御ではない**（利用者に読める文言を
    返すため）。RPC はクライアントから直接呼べるので、アプリ層だけの確認は画面の出し分けと同じ
    （2026-09-09 に、まさにその前提で書かれたコメントごと穴が見つかった）。

- **新しい施設ロールを足すときは 4 軸すべてを決める（2026-09-07）。**
  読む / 書く / マスタを書く / 画面の書き込み UI。決めた内容は
  [`docs/agents/role-rulebook.md`](../../docs/agents/role-rulebook.md)（R-xxx）に 1 行書く。
  「どのロールが何をできるか」は DB の CHECK・`is_facility_writer()`・`is_admin()`・
  `useFacilityRole.ts` の **4 か所**に別々にあり、互いの一致を誰も見ていなかった
  （viewer 追加時に TypeScript 側の更新漏れで誤表示が 2 回起きている）。
  `supabase/migrations/__tests__/role_registry.test.ts` が 4 か所と宣言を両方向で突き合わせ、
  `supabase/__tests__/integration/role-capabilities.integration.test.ts` が表を読んで
  **全ロールを実 DB で実測する**（行を足せば自動で測定対象になる）。

- **`supabase/` を触ったら `bash scripts/run-integration-tests.sh` で全件を通す。**
  素の `npm run test:integration` ではなくこのラッパーを使うと、結果が
  `logs/integration-runs.jsonl` に機械的に記録される（通ったことにはできない。記録するのは exit code）。
  記録が無い・前回が赤・前回から `supabase/` が変わっている、のいずれかなら
  SessionStart hook（`scripts/check-integration-freshness.sh`）が次のセッションで警告する。
  2026-09-07 に統合テストが 2 件、いつからか分からないほど前から赤いまま放置されていたのが理由

- **DBスキーマ変更は必ず `supabase/migrations/` 配下のマイグレーションファイル経由で行う。**
  `execute_sql` 等による直接実行・直接DDL適用は禁止（ローカル・リモート問わず）。
  `supabase db execute`・`psql`直接実行、およびMCP経由のexecute_sql系ツール呼び出しは
  PreToolUse hook（`scripts/check-direct-ddl-execution.sh`、issue #444）で機械的にdenyされる
  （`db push`/`db reset`等の正規のmigration適用手段は対象外）
- **2026-09-07 以降の migration は先頭付近に `-- release-order: db-first` か `-- release-order: app-first`、
  末尾に `-- ROLLBACK:` を書く**（`scripts/check-migration-release-safety.test.sh` が必須にする、issue #757 の 13・25）。
  認可を絞る・列や関数を足す変更は `db-first`、列・表・関数・ポリシーを消す・改名する・型を変える
  変更（contract）は `app-first` にし、`-- contract:` に「どの PR 以降のアプリが参照しなくなったか」を書く。
  順序の理由と混在期間の表は [`../../docs/agents/release-safety-runbook.md`](../../docs/agents/release-safety-runbook.md)
- マイグレーション外で本番/リモートDBに存在するスキーマ変更（トリガー・関数等）を発見した場合は、
  差分をキャッチアップ用マイグレーションとして必ず記録してから作業を進める
- 理由（過去のスキーマドリフト事例）は [`../../docs/agents/decisions/db-rls.md`](../../docs/agents/decisions/db-rls.md#なぜdbスキーマ変更をmigrationファイル経由に限定し直接ddl実行を禁止したか) を参照
- **その表への書き込みを止める DDL を書いたら `-- lock:` の 1 行を添える**（issue #757 の 18）。
  対象は CREATE INDEX（CONCURRENTLY 無し）・ADD CONSTRAINT CHECK / FOREIGN KEY（NOT VALID 無し）・
  ALTER COLUMN ... TYPE。何がどれだけ止まるか、本番規模を測ったかを書く。
  `scripts/check-migration-lock-safety.test.sh`（CI `hooks-test`）が注記の有無だけを機械検査する
  （止まる時間の見積もりは人にしか書けないため）。安全な書き方（CONCURRENTLY / NOT VALID）を
  使っていれば注記は要らない
- **publicスキーマのテーブルを追加/削除するmigrationは、末尾で`SELECT refresh_schema_baseline_snapshot('<そのmigrationのタイムスタンプ>');`を呼ぶ**（issue #305のスキーマドリフト検知が使うbaselineスナップショットを更新するため）。
  呼ばないと、正規のPRレビュー済み変更であっても`table_added`/`table_removed`ドリフトとして恒久的に誤検知され続け、対応するGitHub Issueが自動クローズされなくなる
- **`supabase/migrations/`やRLSポリシーを変更したPRでは、`npm run test:integration`（RLS/IDOR
  integrationテスト）をローカル実行してから作業を完了する**（2026-08-25、Actions無料枠対応で
  `e2e.yml`のPR自動実行を廃止したため）。実行結果は引き継ぎメモの「検証済み」欄に記載する
  - **このうちパスで表せる範囲は、`integration-gate.yml`がPR時点で機械的にゲートする**
    （`supabase/migrations/**`・`supabase/__tests__/**`・`src/lib/supabase/**`・`**/middleware.ts`・`**/proxy.ts`）。
    従来は`push:[main]`のみで、壊れたRLS変更をマージ前に止められなかった
  - **ただしローカル実行義務は無くならない**。`paths`はファイルパスしか見られず、TRI/RISK基準の
    内容ベース判定（auth / facility / tenant / organization / inventory / RLS / policy に
    関わる変更）は表現できないため、上記パス外でRLSの約束に触れる変更はゲートに掛からない
