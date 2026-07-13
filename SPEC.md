# 機能仕様書 — issue #305: PRを介さない本番スキーマ変更の定期ドリフト検知

> ステータス: **承認済み（停止①クリア）— Phase 3実装へ**
> 作成日: 2026-07-13 / 承認日: 2026-07-13
> 由来: Phase 1深掘り調査（Sweep→Draft Spec→Adversarial Verify→Judge Panel→Synthesize、98エージェント）の統合提案
> 承認内容: 5点の判断事項すべて提案通り（v1スコープ3種のみ・GitHub Issueのみ通知・既存ドリフト封印・drift_alert_view anon公開・pg_cron有効化）で承認

---

## Part 1 — 仕様（★人間がレビューする部分）

### 背景・課題

issue #30でSupabase GitHub Integrationを有効化したが、これはPR/ブランチトリガーでのみ動作する。SQL Editor等でPRを介さず直接本番DBに変更が入るケース（`rls_auto_enable`イベントトリガーが実際にPRを介さず入っていた事故パターン、`20260707000001_capture_rls_auto_enable_event_trigger.sql`参照）は、次にPRが発生するまで検知が遅延する。

### 何ができるようになるか

SQL Editor等でPRを介さず本番DBのスキーマが直接変更された場合、**翌日までに自動でGitHub Issueが作成され**、気づけるようになる。具体的には以下の3種類の変更を検知する（v1スコープ）：

1. **テーブルのRLS（行レベルセキュリティ）が無効化された**（最も危険な変更。他施設のデータが見えてしまう等の事故に直結する）
2. **想定外のテーブルが追加された**
3. **既存のテーブルが削除された**

検知は毎日1回、自動で実行される。ドリフトがなければ何も起きない（誤通知なし）。

### 採用する方式（v1・最小スコープ）

- **DB内部の関数（`check_schema_drift()`）が毎日1回、自動実行**され、上記3種のドリフトをチェックしてログテーブルに記録する
- **GitHub Actionsが毎日そのログを確認**し、未対応のドリフトがあれば自動でGitHub Issueを作成する
- 本番DBへの接続情報（パスワード・アクセストークン）はGitHub Secretsに一切置かない（既存方針を継続。`docs/agents/decisions.md`参照）
- Edge Function・外部HTTP通信は使わない（v1では省略し、実績のあるDB内部完結の仕組みに絞る）

### 今回やらないこと（v2以降）

- 関数の追加・削除・シグネチャ変更の検知
- カラムの追加・削除の検知
- イベントトリガーの追加・削除の検知
- 制約（外部キー・一意制約・チェック制約）・インデックスの変更検知
- RLSポリシー個別の削除検知（テーブルのRLS有効/無効のみを見る。ポリシーの中身までは見ない）
- Slack通知等、GitHub Issue以外の通知経路

理由：これらを最初から全部やろうとすると実装・検証コストが跳ね上がり着手が遅れる。まずセキュリティ影響が最大の3種（RLS無効化・テーブル追加・削除）を確実に検知できる状態を最速で作り、対象を広げるのは次のissueで行う。

### 操作の流れ（人間が見るもの）

1. 何もしなくてよい。毎日自動でチェックが走る
2. ドリフトが検知されると、GitHub Issueが自動作成される（ラベル: `schema-drift`, `bug`）📸
3. Issueには「何が」「いつ検知されたか」が書かれている
4. 対応（マイグレーション作成 or 意図した変更なら追認）した後、次回チェックでドリフトが消えていれば自動でIssueがクローズされる

> 📸 本機能はブラウザ画面を伴わない自動処理（DB関数 + GitHub Actions）のため、動作確認はGitHub Issue作成の実物とAction実行ログで行う。E2E（Playwright）のスクリーンショット撮影ポイントはない。

### 受け入れ条件（チェックリスト）

#### 検知の正確性

- [ ] ローカルSupabaseで `SELECT * FROM check_schema_drift();` を実行し、ドリフトがない状態でゼロ行が返る
- [ ] SQL Editorで `CREATE TABLE public.test_drift (id uuid);` を実行後に再実行すると、`table_added` の1行が検知される（その後 `DROP TABLE` で後片付け）
- [ ] SQL Editorで既存テーブルの `ALTER TABLE ... DISABLE ROW LEVEL SECURITY;` を実行後に再実行すると、`rls_disabled` の1行が検知される（その後 `ENABLE ROW LEVEL SECURITY` で戻す）
- [ ] baseline snapshotに存在するテーブルをSQL Editorで `DROP TABLE` すると、`table_removed` の1行が検知される
- [ ] 同じドリフトが未解決のまま複数回チェックが走っても、ログに重複して記録されない（冪等性）
- [ ] `schema_drift_log` / `schema_baseline_snapshots` テーブル自体が削除された場合、`check_schema_drift()` の実行がエラーとして失敗し、その失敗がpg_cronの実行履歴に残る

#### GitHub Issue連携

- [ ] 未解決ドリフトが1件以上ある状態でGitHub Actionsを実行すると、`schema-drift`・`bug`ラベル付きのIssueが作成される
- [ ] 既にIssueが作成済みの未解決ドリフトについては、再実行してもIssueが重複作成されない
- [ ] ドリフトが解消された後の実行で、対応するIssueが自動でクローズされる
- [ ] GitHub Actions用のトークンは標準の`GITHUB_TOKEN`（`issues:write`権限のみ）を使い、個人アクセストークンの発行・管理は不要である

#### セキュリティ

- [ ] 本番DBの接続パスワード・Service Role Key・Supabase Access TokenはGitHub Secretsに一切登録しない
- [ ] GitHub Actionsが読み取るビュー（`drift_alert_view`）はanon keyで読める設計だが、公開される情報はドリフトの種類・対象オブジェクト名・検知日時のみで、それ以上の詳細情報（`detail`列の中身）は公開されない
- [ ] `check_schema_drift()`はservice_roleのみ実行可能（GRANT EXECUTEがservice_roleに限定されている）

#### 運用

- [ ] テスト専用Supabase環境ではこのスケジュールチェックは動作しない（本番環境限定）
- [ ] `docs/agents/decisions.md` に本設計（Edge Function不使用・GitHub Actions日次ポーリング方式を選んだ理由）が追記される

---

### 判断が必要な点（レビュー時に確認）

1. **pg_cron拡張の有効化を承認するか** — Supabase Dashboard → Database → Extensionsから有効化する。DB内部スケジューラとして必須。無効化できない/したくない場合は、GitHub Actions側からRPC経由で`check_schema_drift()`を直接呼ぶ代替方式に変更する（フォールバックとして実装計画には両方含める）
2. **v1の検知スコープ（RLS無効化・テーブル追加・テーブル削除の3種のみ）で妥当か** — 関数・カラム・トリガー等はv2に先送りするが、これで最初の一歩として十分な価値があるか
3. **通知先はGitHub Issueのみで確定してよいか**（Slack等は今回対象外）
4. **本番の「既存の未記録ドリフト」の扱い** — 本仕様の初回マイグレーション適用時点のテーブル一覧を「あるべき状態」としてそのまま封印する設計にする（過去に本当にドリフトしていたものがあっても、そこは合格ラインとして扱われる）。適用前に本番の棚卸しを別途行うべきか、それともこのまま封印してよいか
5. **`drift_alert_view`をanon keyで公開すること**への承認 — ドリフト種別・対象オブジェクト名・検知日時が匿名で読み取り可能になる（詳細情報は非公開）。この程度の情報公開は許容できるか

---

## Part 2 — 実装計画（AI用・技術詳細・レビュー不要）

### 前提

- RISK判定: `supabase/migrations/`・RLS・policyドメインに触れるため **RISK=はい（M/Lレーン必須）**
- 既存方針の継承: 本番Supabase接続情報をGitHub Secretsに置かない（`docs/agents/decisions.md`「なぜスキーマドリフト検知を自前cronではなくSupabase GitHub Integrationで始めたか」と同じ制約を維持する。本仕様はそれを補完するもので、置き換えではない）
- `check_schema_drift()`のテーブル追加/削除判定は、`schema_baseline_snapshots`にmigration適用時点の`pg_tables`実データをそのまま記録する方式（手動でのテーブル名列挙はしない。導出漏れリスクを構造的に避けるため）

### drift_type / event_kind の値と判定基準（Part 3セルフチェック対応）

**`drift_type`**（`schema_drift_log.drift_type`、TEXT）

| 値 | 判定基準 | 下流の反応 |
|---|---|---|
| `rls_disabled` | `pg_class.relrowsecurity = false` のpublicスキーマテーブルが1件でもある | `drift_alert_view`に表示 → GitHub Actionsが`priority: high`としてIssue本文に明記 |
| `table_added` | 最新snapshotの`snapshot`配列に存在しないテーブルが`pg_tables`に存在する | `drift_alert_view`に表示 → 通常のIssue作成対象 |
| `table_removed` | 最新snapshotの`snapshot`配列に存在するテーブルが`pg_tables`に存在しない | `drift_alert_view`に表示 → 通常のIssue作成対象 |
| `error` | `check_schema_drift()`内部で想定外の例外を捕捉した場合（基盤テーブル消失以外） | `drift_alert_view`には出さない（object_nameがNULLになりうるため）。`schema_drift_log`への記録のみとし、`cron.job_run_details`の失敗ログと合わせて別途確認する運用とする |

**`event_kind`**（`schema_drift_log.event_kind`、TEXT CHECK IN ('detected','acknowledged','resolved')）

| 値 | 判定基準 | 下流の反応 |
|---|---|---|
| `detected` | `check_schema_drift()`が新規ドリフトを検知した瞬間にINSERTする初期値 | `drift_alert_view`の対象（`resolved_at IS NULL`かつ`event_kind='detected'`） |
| `acknowledged` | 人間がドリフトを「意図した変更」と確認し、対応するmigrationを作らずクローズしたい場合に手動でUPDATEする（v1では専用UIなし、SQLで直接更新） | `drift_alert_view`の対象から除外（`resolved_at`が設定される想定、またはWHERE句で`event_kind != 'acknowledged'`も対象外にする） |
| `resolved` | 次回`check_schema_drift()`実行時に、同一`drift_type`+`object_name`の組が再検知されなかった場合、対応する`detected`行の`resolved_at`を自動更新する | `drift_alert_view`の対象から除外。GitHub Actions側が対応するIssueをクローズする |

**合計3種類の`drift_type`・3種類の`event_kind`、本文中の記載件数と一致することを確認済み。**

### 実装セット一覧（依存順）

#### セット1: DBスキーマ（マイグレーション、直列内で最初）

**触るファイル（新規）:**
- `supabase/migrations/20260714000001_create_schema_drift_detection.sql`

**内容（骨格）:**
```sql
-- 1. baseline snapshot（append-only）
CREATE TABLE schema_baseline_snapshots (
  epoch TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_baseline_snapshots ENABLE ROW LEVEL SECURITY;
-- service_role以外ポリシーなし = service_roleのみアクセス可（既存パターンに合わせる）

-- 2. ドリフトログ（append-only、冪等性は部分ユニーク制約で担保）
CREATE TABLE schema_drift_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drift_type TEXT NOT NULL,
  object_name TEXT,
  detail JSONB,
  event_kind TEXT NOT NULL DEFAULT 'detected' CHECK (event_kind IN ('detected','acknowledged','resolved')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  issue_url TEXT
);
CREATE UNIQUE INDEX schema_drift_log_open_unique
  ON schema_drift_log (drift_type, object_name) WHERE resolved_at IS NULL;
ALTER TABLE schema_drift_log ENABLE ROW LEVEL SECURITY;

-- 3. 初期snapshot（このmigration適用時点の実データをそのまま封印）
INSERT INTO schema_baseline_snapshots (epoch, snapshot)
SELECT '20260714000001', jsonb_agg(tablename ORDER BY tablename)
FROM pg_tables WHERE schemaname = 'public';

-- 4. check_schema_drift() 本体
CREATE OR REPLACE FUNCTION check_schema_drift()
RETURNS TABLE (drift_type TEXT, object_name TEXT, detail JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  latest_snapshot JSONB;
BEGIN
  -- 自己参照ガード: 基盤テーブル自体の消失を最優先で検知
  IF to_regclass('public.schema_drift_log') IS NULL
     OR to_regclass('public.schema_baseline_snapshots') IS NULL THEN
    RAISE EXCEPTION 'schema drift detection base tables are missing (self-referential integrity failure)';
  END IF;

  SELECT snapshot INTO latest_snapshot
  FROM schema_baseline_snapshots ORDER BY epoch DESC LIMIT 1;

  -- 1. RLS無効化検知（ホワイトリスト不要、public全テーブル対象）
  --    自テーブル(schema_baseline_snapshots/schema_drift_log)もRLS有効化前提のため対象に含む
  RETURN QUERY
  SELECT 'rls_disabled', c.relname, jsonb_build_object('schema', 'public')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false;

  -- 2. テーブル追加検知
  RETURN QUERY
  SELECT 'table_added', t.tablename, jsonb_build_object('schema', 'public')
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND NOT (latest_snapshot ? t.tablename);

  -- 3. テーブル削除検知
  RETURN QUERY
  SELECT 'table_removed', s.name, jsonb_build_object('schema', 'public')
  FROM jsonb_array_elements_text(latest_snapshot) AS s(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = s.name
  );
END;
$$;
GRANT EXECUTE ON FUNCTION check_schema_drift TO service_role;

-- 5. ドリフト記録関数（check_schema_drift()の結果をログに冪等insertし、resolved自動更新も行う）
CREATE OR REPLACE FUNCTION record_schema_drift()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- 新規ドリフトを記録（既存の未解決行があればスキップ）
  INSERT INTO schema_drift_log (drift_type, object_name, detail)
  SELECT d.drift_type, d.object_name, d.detail FROM check_schema_drift() d
  ON CONFLICT (drift_type, object_name) WHERE resolved_at IS NULL DO NOTHING;

  -- 前回検知されたが今回検知されなかった行はresolvedにする
  UPDATE schema_drift_log l
  SET event_kind = 'resolved', resolved_at = now()
  WHERE l.event_kind = 'detected' AND l.resolved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM check_schema_drift() d
      WHERE d.drift_type = l.drift_type AND d.object_name = l.object_name
    );
END;
$$;
GRANT EXECUTE ON FUNCTION record_schema_drift TO service_role;

-- 6. GitHub Actions公開用ビュー（詳細非公開・未解決分のみ）
CREATE VIEW drift_alert_view AS
SELECT id, drift_type, object_name, detected_at, issue_url
FROM schema_drift_log
WHERE event_kind = 'detected' AND resolved_at IS NULL;
GRANT SELECT ON drift_alert_view TO anon;
```

**テスト観点:**
- `supabase/migrations/__tests__/schema_drift_detection.test.ts`（既存`tech_debt_migrations.test.ts`と同じ静的SQL検証方式）
  - `record_schema_drift()`・`check_schema_drift()`・`drift_alert_view`が定義されていること
  - `schema_drift_log_open_unique`部分ユニークインデックスの`WHERE resolved_at IS NULL`条件が含まれること
  - `GRANT SELECT ON drift_alert_view TO anon`が含まれること（過剰付与ではなくSELECTのみであることも確認）
- ローカル`supabase db reset`後、`SELECT * FROM check_schema_drift();`がゼロ行を返すことを手動確認（受け入れ条件1件目に対応）

**触るファイル:**
- `supabase/migrations/20260714000001_create_schema_drift_detection.sql`（新規）
- `supabase/migrations/__tests__/schema_drift_detection.test.ts`（新規）

---

#### セット2: pg_cronスケジュール設定（セット1完了後・直列）

**触るファイル（新規）:**
- `supabase/migrations/20260714000002_schedule_schema_drift_check.sql`

**内容（骨格）:**
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'schema-drift-daily-check',
  '0 23 * * *', -- UTC 23:00 = JST 8:00
  $$ SELECT record_schema_drift(); $$
);
```

**補足（pg_cronが有効化できない場合のフォールバック）:**
- 前提確認1（Part 1参照）でpg_cron不可の判断が出た場合、このセットはスキップし、代わりにセット3（GitHub Actions）側から`record_schema_drift()`をRPC経由（service_role key使用、ただしこれはGitHub Secretsではなく別途安全な経路の検討が必要—**この場合は追加の人間判断が必要なため、pg_cron不可判定が出た時点でこのセットの実装者は着手せず、統合ゲートで報告すること**）

**テスト観点:**
- ローカルで`SELECT * FROM cron.job WHERE jobname = 'schema-drift-daily-check';`でスケジュール登録を確認
- `SELECT cron.run_job((SELECT jobid FROM cron.job WHERE jobname = 'schema-drift-daily-check'));`で手動実行し、エラーが出ないことを確認

**触るファイル:**
- `supabase/migrations/20260714000002_schedule_schema_drift_check.sql`（新規）

---

#### セット3（セット1と並列可）: GitHub Actionsワークフロー

**触るファイル（新規）:**
- `.github/workflows/schema-drift-check.yml`

**内容（骨格）:**
- `schedule: cron: '0 0 * * *'`（UTC 0:00、DB側チェックより後に実行されるよう時刻をずらす）+ `workflow_dispatch`（手動実行可能に）
- `curl`で`drift_alert_view`をanon keyで取得（本番Supabase URLとanon keyのみ使用。パスワード・service role key不使用）
- 未解決ドリフト（`issue_url IS NULL`の行）ごとに`gh issue create`でIssue作成し、作成したURLを`schema_drift_log`に書き戻す（この書き戻しには専用のRPC関数が必要 → セット1に`record_issue_url(log_id UUID, url TEXT)`をSECURITY DEFINERで追加し、service_role権限で叩けるようにする。**この関数はセット1側の追加スコープとして実装者間で調整すること**）
- 対応済み（`resolved`になった）ドリフトに紐づく`issue_url`があれば`gh issue close`する

**テスト観点:**
- `workflow_dispatch`での手動実行が成功すること（ローカルでは検証できないため、実装後に一度手動トリガーして確認する統合ゲート項目とする）
- ダミーのドリフトデータに対してIssue作成・重複防止・クローズの3パターンをステージング的に確認する手順をREADME相当にコメントで残す

**触るファイル:**
- `.github/workflows/schema-drift-check.yml`（新規）

---

#### セット4（独立・並列可）: decisions.md更新

**触るファイル（既存）:**
- `docs/agents/decisions.md`

**内容:**
- 「なぜPRの外側のスキーマドリフト検知にEdge Functionを使わずpg_cron + GitHub Actionsポーリングを採用したか」を追記
- 検討した代替案（Edge Function + Webhook方式）を不採用にした理由（pg_net依存・デプロイパイプライン未定義・GITHUB_TOKEN管理コストの3点）を記録

---

### 並列グループ宣言

```
Wave 1 ──┬── Set 1 (DBスキーマ)     supabase/migrations/20260714000001_*.sql + __tests__
          └── Set 4 (decisions.md)  docs/agents/decisions.md
             ↓ Set 1完了後
Wave 2 ──┬── Set 2 (pg_cronスケジュール)  supabase/migrations/20260714000002_*.sql
          └── Set 3 (GitHub Actions)      .github/workflows/schema-drift-check.yml
             （Set 3はSet 1のrecord_issue_url関数シグネチャに依存するため、Set 1完了後に着手）
統合ゲート:
  - migrationのローカル適用確認（db reset）
  - pg_cronジョブの手動実行確認
  - GitHub Actionsのworkflow_dispatch手動実行確認（可能な範囲で）
```

Set 1とSet 4は互いに別ファイルのみを触るため並列可能。Set 2・Set 3はSet 1完了後（関数シグネチャ確定後）に着手する。

### 型・データアクセス層の方針

- 本機能はDB関数・SQLマイグレーション・GitHub Actionsのみで完結し、`src/`配下のTypeScriptコード・APIルートは一切変更しない
- 型安全性はPostgreSQLのCHECK制約（`event_kind`）とSQLの静的検証テスト（既存`tech_debt_migrations.test.ts`パターン踏襲）で担保する
