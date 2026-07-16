# SPEC: 在庫アイテムへの有効期限カラム追加

## Part 1: 概要
在庫アイテム(inventory_items)に有効期限(expiry_date)を追加し、一覧画面で表示できるようにする。

## Part 2: 実装計画

### DBスキーマ変更
- `supabase/migrations/` に、`inventory_items` テーブルへ `expiry_date DATE` カラム（NULL許容）を
  追加する新規マイグレーションファイルを作成すること。
- ファイル名は `<タイムスタンプ>_add_expiry_date_to_inventory_items.sql` の形式でよい。
- このfixtureはeval専用の孤立ディレクトリで実行されるため、
  `refresh_schema_baseline_snapshot` の呼び出しは省略してよい。

### 実装セット一覧（依存順）
1. db-impl: 上記マイグレーション
2. ui-impl: 一覧画面に有効期限列を追加（このfixtureのeval対象外）
