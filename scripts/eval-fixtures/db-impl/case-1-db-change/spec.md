# SPEC: 在庫アイテムにメモ欄を追加する機能

## Part 1: 概要
在庫アイテム（`inventory_items`テーブル）に、任意のテキストメモを保存できる`memo`カラムを追加する。

## Part 2: 実装計画

### DBスキーマ変更
`inventory_items`テーブルに以下のカラムを追加するマイグレーションを作成する。

- カラム名: `memo`
- 型: `text`
- NULL許容: 可（既存行への影響なし）
- デフォルト値: なし

マイグレーションファイルは `supabase/migrations/` 配下に、既存の命名規則
（`<timestamp>_<説明>.sql`）に従って追加すること。

### 実装セット一覧
1. db-impl: 上記マイグレーションの作成
2. data-impl: （このfixtureでは対象外）
