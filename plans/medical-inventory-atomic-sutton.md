# Context

施設一覧画面から一般ユーザー向けに新規登録・編集・削除ボタンを非表示にする。
管理操作UIを削除し、閲覧専用の画面に変更する。

# 変更ファイル

## 1. `src/app/facilities/page.tsx`

- `+ 新規施設を登録` ボタン（45〜51行目）を削除
- `handleDelete` 関数を削除（不要になるため）
- `FacilityList` への `onEdit` / `onDelete` props を削除

## 2. `src/components/facilities/FacilityList.tsx`

- `onEdit` / `onDelete` を props から削除
- `FacilityListProps` 型から両プロパティを削除
- 「操作」列ヘッダーを削除
- 各行の編集・削除ボタンを含む `<td>` を削除
- 空状態メッセージの「「新規施設を登録」から追加してください」を削除

# 確認方法

`npm run dev` で施設一覧ページ (`/facilities`) を開き、
ボタン類が表示されていないことを目視確認する。
