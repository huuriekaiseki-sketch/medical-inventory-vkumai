# Issue #628: Supabase生成型の導入

## 目的

ローカルmigrationから生成した`Database`型をコミットし、DB境界の型ドリフトをCIで検出する。

## 受入条件

- `src/types/database.generated.ts`をローカルSupabaseから生成してコミットする。
- E2EのローカルSupabase起動後に生成型の鮮度検査を実行する。
- 型の正本はローカルmigrationとし、本番DBへ接続しない。
- 既存のrepositoryを一つ、`SupabaseClient<Database>`境界へ段階導入する。
- migration変更、型更新、typecheck、rollback手順を記録する。

## 既知の限界

生成型とmigrationが一致していても、本番SQL Editor等の直接変更は別のschema drift検知が必要である。全repositoryの置換は段階導入とする。
