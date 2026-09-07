# リリースの安全性（順序・混在・ロールバック）

DB（Supabase）とアプリ（Vercel）は別々に出る。migration は手元の `supabase db push`（都度確認）、
アプリは main への push で Vercel が自動デプロイする（Supabase GitHub 連携の「Deploy to production」は
意図的に OFF。[decisions/db-rls.md](./decisions/db-rls.md#なぜスキーマドリフト検知を自前cronではなくsupabase-github-integrationで始めたか)）。
つまり**順序は人が決める**。順序を間違えると、データ破壊よりも「権限が開く方向の退行」が起きる
（issue #757 の 13・25）。本ファイルはその順序の規約と、途中失敗・混在・ロールバックの手順。

## 原則: DB が先、縮めるのは後（expand → contract）

| 変更の種類 | 順序 | 理由 |
| --- | --- | --- |
| 認可を**絞る**（新しい RLS ポリシー・REVOKE・`has_aal2()` 追加・トリガーで拒否） | **DB を先に**当ててからアプリを出す | アプリが先に出ると、新しいアプリが「DB が守っている前提」で動く時間ができる（P-031 の aal2 は DB が守る。アプリだけ先に出ても守られない） |
| 列・表・関数を**足す**（expand。`ADD COLUMN`、`CREATE FUNCTION`、`DEFAULT` 付きの引数追加） | **DB を先に**当ててからアプリを出す | 旧アプリは新しい列・引数を知らなくても動く（#772 の `p_client_request_id DEFAULT NULL` が例）。逆順だと新アプリが無い列を参照して 500 |
| 列・表・関数・ポリシーを**消す・改名する・型を変える**（contract） | **アプリを先に**出し、旧アプリがそれを参照しなくなってから DB を当てる | 旧アプリが動いている間に消すと、旧アプリが壊れる。認可の場合は「古いポリシーを消して新しいポリシーを足す」を 1 migration に入れる（`DROP POLICY` → `CREATE POLICY` を同一トランザクション） |
| 認可を**緩める**（許可を足す） | 原則やらない。やるなら DB を最後に | 緩める migration が先に出ると、緩んだ状態でアプリが古いまま動く時間ができる |

migration には先頭コメントに `-- release-order: db-first` か `-- release-order: app-first` を書く
（2026-09-06 以降の migration は `scripts/check-migration-release-safety.test.sh` が必須にする）。
contract の DDL（`DROP COLUMN` / `DROP TABLE` / `RENAME` / `ALTER COLUMN ... TYPE` / `SET NOT NULL` /
`DROP FUNCTION`）を含む migration は `-- contract:` に「どのアプリの版から参照しなくなったか（PR 番号）」を書く。
同じ PR で `DROP FUNCTION` → `CREATE OR REPLACE FUNCTION`（引数追加で作り直す）をする場合は、旧シグネチャの
呼び出しが新関数の `DEFAULT` で通ることを `-- contract:` に書く（#772 の型）。

## 手順（本番リリース）

1. PR がマージされ、CI（unit・lint・型・build・hooks-test・docs）が緑であることを見る。migration を含む PR は
   `integration-gate.yml` の統合ジョブも緑であること。
2. migration を含む場合: `-- release-order:` を読む。
   - `db-first`: 手元で `supabase link`（本番）→ `supabase db push`（都度確認）→ 適用ログに migration 名が出ることを確認 → 3 へ。
   - `app-first`: 3 を先に行い、Vercel のデプロイが Ready になってから `db push`。
3. Vercel のデプロイ（main への push で自動）が Ready になることを見る。失敗していれば 5 へ。
4. **権限が開く方向の退行が無いことの確認**（5 分）:
   - 他施設ユーザーで `npx playwright test e2e/api-cross-facility-attack.spec.ts` を本番向けには回せない（ローカル Supabase 前提）ので、本番では「他施設の一覧 URL を開いてアクセス権限エラーになる」（P-016 の手動版）と「MFA 登録済みの利用者で /mfa-challenge に送られる」を目視する。
   - スキーマドリフト検知の翌日の結果（issue が立たない）で、migration が期待どおり当たっていることを裏取りする。
5. ロールバック:
   - アプリ: Vercel の Deployments から直前の Ready なデプロイを「Promote to Production」（即時）。
   - DB: migration 末尾の `-- ROLLBACK:` の手順（2026-09-06 以降の migration は必須）。`db-first` で当てた migration をアプリのロールバック後に戻すときは、**縮める方向に戻す**（消した列を戻す）のは expand 扱いで安全、**緩める方向に戻す**（REVOKE を GRANT に戻す）のは 4 の確認を再度行う。
   - 順序の原則はロールバック時も同じ: 認可を絞った migration は最後まで残し、アプリだけ戻す。

## 混在期間（旧フロント + 新 API、新フロント + 旧 DB）

| 混在 | 起きる場面 | 安全か | 根拠 |
| --- | --- | --- | --- |
| 旧フロント（デプロイ前に開いたタブ）+ 新 API Route | Vercel デプロイ直後 | 安全（互換） | body の新しい任意項目（例: `clientRequestId`）は無くても従来どおり動く。必須項目を足すときは route が 400 を返すだけで権限は開かない |
| 新 API Route + 旧 DB（migration 未適用） | `db-first` を守らなかったとき | **危険** | 新 route が新しい列・関数を前提にすると 500。認可を絞る migration が未適用なら、その間は絞られていない |
| 新 DB（contract 済み）+ 旧アプリ | `app-first` を守らなかったとき | 危険（可用性） | 消した列・関数を旧アプリが呼んで 500。権限は開かない |
| 新 DB（expand 済み）+ 旧アプリ | 通常の `db-first` | 安全 | 旧アプリは新しい列・引数を知らずに動く（#772 で実測: 鍵なしの呼び出しは従来どおり） |
| JWT の古いクレーム + 新 RLS | 常時（最大 1 時間） | 安全 | 認可はクレームを使わない（P-023） |

## 権限が開く方向の退行のチェックリスト（migration をレビューするとき）

- `DROP POLICY` があるなら、同じ migration に置き換えの `CREATE POLICY` があるか（無ければその表は RLS 有効のまま deny-all になる＝閉じる方向なので可用性の問題。逆に `DISABLE ROW LEVEL SECURITY` は P-040 の静的テストが止める）
- `GRANT` を足すなら、対象ロールに anon / PUBLIC が含まれていないか（P-043 の ratchet が公開 RPC を数える）
- `SECURITY DEFINER` を足すなら、関数内に認可があるか（known-failure-patterns「SECURITY DEFINER + GRANT EXECUTE の認可バイパス」）
- `CREATE OR REPLACE FUNCTION` で認可述語（`is_facility_member` 等）を書き換えるなら、統合テスト全件（P-010〜P-045）を素の DB で回したか
- `-- release-order:` と `-- ROLLBACK:` があるか（構造テストが 2026-09-06 以降の migration に要求）

## 更新の引き金

- Supabase GitHub 連携の「Deploy to production」を ON にするとき（順序が機械になるので、本ファイルの「DB が先」を CI の順序に置き換える）
- Vercel の preview 環境に本番 DB を向けていると分かったとき（access-path-inventory の X-030）
- 複数施設の同時利用が始まり、リリース時刻の調整（夜間）が要るようになったとき
