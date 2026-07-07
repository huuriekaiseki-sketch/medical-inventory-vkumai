# 設計判断の記録

「なぜその設計・ルールにしたか」を記録する。ルール本体は `common.md` を参照。
ここは理由だけを書き、実装詳細やハウツーは書かない。

## なぜ施設分離をRLS + is_facility_member関数で実現したか

`user_facilities` テーブルでユーザーと施設の対応を管理し、`is_facility_member()` を
すべての施設固有テーブルのRLSポリシーで使う設計にした。

アプリケーション層のif文でfacility_idをチェックする方式だと、チェック漏れのエンドポイントが
1つでもあれば他施設のデータが見えてしまう。RLSをDB層に置くことで、どのAPIルート・どのクエリ
経路を通っても機械的に遮断される。

## なぜ管理者判定をDB role（user_facilities.role）ベースにしたか

当初 `ADMIN_EMAILS` 環境変数によるフォールバックがあったが、`requireAdmin()` の判定を
DBの `user_facilities.role = 'admin'` ベースに一本化した（`docs/specs/admin-role-migration.sql`）。

環境変数ベースだと、デプロイ環境ごとに設定がずれる／環境変数の変更履歴がgit管理されない
という問題があった。DBに判定根拠を置くことで、管理者の追加・削除がSQLとして履歴に残る。

## なぜprice_historiesはdistributor_product側の施設チェックを素通りさせるか

`price_histories` のRLSは `entity_type = 'distributor_product'` の場合は無条件で `true` を返す
（`hospital_price` の場合のみ `is_facility_member` でチェックする）。

`distributor_product` は施設非依存の共通マスタであり、その価格変更履歴も全施設で共有する
情報だから。`hospital_price` は施設固有の価格なので、そちらだけ施設チェックが必要。

## なぜTRI/RISK判定を機械判定にし、人の裁量で緩めないことにしたか

`supabase/migrations/` ・`src/lib/supabase/` ・`middleware.ts` ・auth/facility/tenant/
organization/inventory/RLS/policyドメインに触れる変更は、無条件でM/L扱い（RISK=はい）と
common.mdに定めている。

これらは施設間データ越境・権限昇格など、事故った際の被害が大きく後戻りしにくい領域。
「今回は軽微だから」という都度の判断を許すと、判断者によって基準がぶれて事故を防げなくなる
ため、レビュー省略可否の裁量を人間に与えない設計にした。

## なぜDBスキーマ変更をmigrationファイル経由に限定し、直接DDL実行を禁止したか

過去に `execute_sql` 等でリモートDBに直接適用されたイベントトリガー（`rls_auto_enable` /
`ensure_rls`）が、どのmigrationファイルにも記録されていないスキーマドリフトとして発覚した
（`20260707000001_capture_rls_auto_enable_event_trigger.sql` で復元・記録）。

migrationファイルだけがスキーマの唯一のソースオブトゥルースであるべきで、直接DDL実行を
許すとローカル・リモート・disaster recoveryの間でスキーマが一致しなくなる。この事例を機に、
直接実行を禁止し、既存の未記録スキーマ変更を見つけた場合は必ずキャッチアップmigrationとして
記録するルールにした。

## なぜE2E/BSGはテスト専用Supabaseのみに接続する設計にしたか

`NODE_ENV=test` では `.env.local`（本番接続情報）を読み込ませず、`e2e/env-guard.ts` で
許可ホスト以外への接続を即失敗させる多層防御にしている。

E2Eテストやシード投入は本番相当の操作（データ作成・削除・RLSトリガー実行）を伴うため、
設定ミス1つで本番DBに書き込まれるリスクがある。環境変数の設定ミスだけに頼らず、実行時に
接続先を機械的に検証することで、ヒューマンエラーが起きても本番事故に直結しないようにした。
