# SPEC: 設定ドリフト検知の「期待値」側を作る（issue #757 の 35 の手元側）

## Part 0: 調査で分かったこと（2026-09-18 の実測）

| # | 事実 | 根拠 | 設計への影響 |
| --- | --- | --- | --- |
| 1 | **`.env.example` が存在しない** | `git ls-files "*env*"` → あるのは `.env.test.example` だけ | issue の前提「migration と `.env.example` から作った期待値」の**片方が無い**。作るのも本 PR に含めるかの判断が要る（判断 A） |
| 2 | 製品が使う実行時の環境変数は 5 つ | `process.env.*` の走査: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `ADMIN_EMAILS` / `NEXT_PUBLIC_SITE_URL`（他は NODE_ENV・CI・TZ 等の基盤側と、検査スクリプト専用） | 期待値の中身はこの 5 つ。手で数えず走査で出す |
| 3 | migration に GRANT 61 文 / REVOKE 72 文 | `supabase/migrations` の走査（88 ファイル） | **順に再生しないと現存集合が出ない**（REVOKE のほうが多い） |
| 4 | **RLS ポリシーの再生器が既にある** | `scripts/lib/replay-rls-policies.mjs`（動的 DDL の展開まで対応。読めない行は名指しする） | 同じ型で GRANT/REVOKE を再生できる。**ゼロから作らない** |
| 5 | Storage を使っていない | `docs/agents/data-lifecycle-inventory.md` の D-033「機能が無い」 | Storage policy は対象外（生えたら足す） |
| 6 | DB スキーマのドリフトは既に検知済み | `schema-drift-check.yml` + pg_cron（issue #305） | **本件はその重複ではない**。あちらは「DB 内部のスナップショット比較」、こちらは「migration から導いた期待値と実環境の突合」 |

## Part 1: 判断（**レビューしてほしい点**）

### 判断 A: `.env.example` が無い問題をどうするか

| 案 | 内容 | 評価 |
| --- | --- | --- |
| **A-1（採用案）** | 本 PR で `.env.example` を**生成物として**作る。`process.env.*` の走査から変数名を出し、`--check` で鮮度を見る | 期待値の出所が機械で保てる。値は書かず**名前と必須/任意だけ**。秘密は入らない |
| A-2 | 手で `.env.example` を書く | 腐る。このリポジトリが繰り返し踏んできた型 |
| A-3 | 環境変数は範囲外にして GRANT/RLS だけやる | issue の記述の半分を落とす |

**A-1 を採る。** ただし「必須か任意か」は走査から自動判定できない（`?? 既定値` の有無で近似はできるが誤る）ので、
**`aidd.config.json` に宣言を置き、走査と突き合わせる**（宣言漏れ・幽霊の両方向を検査）。

### 判断 B: 「期待値」をいつ検証できるようにするか（**ここが本題**）

issue は「Vercel / Supabase ダッシュボードの実値が要るので外部待ち」としているが、**ローカル Supabase には届く**。

| 案 | 内容 | 評価 |
| --- | --- | --- |
| **B-1（採用案）** | 期待値を出す側を作り、**比較相手をローカル Supabase にして端から端まで動かす**。本番の接続先は差し替え可能にしておく | 「期待値だけ作って比較は未検証」を避けられる。**比較の形が正しいことを実測できる** |
| B-2 | 期待値の生成だけ作り、比較は本番に届く日まで書かない | 比較の形が正しいか永久に分からない。作った日が一番よく分かっているのに測らないのは C-022 の型 |

**B-1 を採る。** 外部待ちなのは**本番という接続先**であって、**比較そのもの**ではない。

### 判断 C: 生成物をコミットするか

**する。** 既存の型（`harness-map.md`・`dist/plugins`・`aidd-graph`）に揃え、`--check` で鮮度を見る。
コミットしないと「いつの姿に対する期待値か」が追えない。

## Part 2: 作るもの

- `scripts/lib/replay-grants.mjs` — migration を順に再生して GRANT の現存集合を出す（`replay-rls-policies.mjs` と同じ型。読めない行は名指しする）
- `scripts/lib/build-config-expected.mjs` — 期待値を 1 つの JSON にまとめる（RLS ポリシー集合・GRANT 集合・環境変数名）
- `docs/agents/config-expected.json` — 生成物（コミットする）
- `.env.example` — 生成物（名前と必須/任意だけ。値は書かない）
- `scripts/check-config-drift.sh` — 期待値と**実 DB** を突き合わせる。接続先は環境変数で差し替え（既定はローカル）
- `scripts/check-config-drift.test.sh` — 回帰テスト（RED 方向を含む）

## Part 3: 受け入れ条件

- [ ] `replay-grants.mjs` が GRANT/REVOKE を順に再生し、**読めなかった行を黙って飛ばさず名指しする**
- [ ] 期待値の JSON が決定的（2 回生成して一致）
- [ ] `--check` で生成物の鮮度を見る（古ければ落ちる）
- [ ] `.env.example` の変数名が `process.env.*` の走査と一致する。**宣言漏れも幽霊も両方向で検査**
- [ ] **ローカル Supabase と突き合わせて、実際に差分を検出できることを実測**（わざとポリシーを 1 本落として落ちるか）
- [ ] 差分が無ければ黙る。**接続できないときは「確認不能」と言う**（合格にしない）
- [ ] 秘密の値が生成物に一切入らない（名前だけ）

## Part 4: 対象外

- 本番 / staging への接続（**外部待ち**。接続先を差し替えられる形だけ作る）
- GitHub のブランチ保護・権限の比較（`gh api` で取れるが、**有料化の判断（#757 の 6）と一体**なので分離）
- Storage policy（機能が無い。生えたら足す）

## Part 5: 危険なところ

| リスク | 対処 |
| --- | --- |
| **秘密が生成物に混ざる** | 値を一切読まない（名前だけ）。`check-secret-leak.test.sh` が既に走る |
| 再生の取りこぼしで「差分なし」の嘘 | 読めない行を名指しする（`replay-rls-policies.mjs` と同じ。C-044） |
| 接続できないのを緑と読む | 「確認不能」と言って合格にしない |
| 新しい検査 1 本ぶんの付帯作業 | 是正の登録簿・`plugin-layout.json`（配布層と `checkScopes`）・`harness-registry.json`・`build-plugin.sh` の再生成。**2026-09-18 に 6 回落ちて学んだ順序** |
