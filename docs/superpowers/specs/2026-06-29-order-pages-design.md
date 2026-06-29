# 発注系ページ設計書

**作成日**: 2026-06-29  
**対象ブランチ**: feature/phase2-multitenant

---

## 概要

施設詳細ページ（`/facilities/[id]`）の発注ボタン（症例発注・消耗品発注・短貸発注・短貸返却）を押すと、
モーダルではなく**別ページへ遷移**するよう変更する。
各ページは「過去の発注一覧 + 新規作成ボタン」を提供する。

---

## URL 構造

| ページ | URL |
|---|---|
| 症例発注 一覧 | `/facilities/[id]/case-orders` |
| 症例発注 新規作成 | `/facilities/[id]/case-orders/new` |
| 消耗品発注 一覧 | `/facilities/[id]/consumable-orders` |
| 消耗品発注 新規作成 | `/facilities/[id]/consumable-orders/new` |
| 短貸発注 一覧 | `/facilities/[id]/loan-orders` |
| 短貸発注 新規作成 | `/facilities/[id]/loan-orders/new` |
| 短貸返却 一覧 | `/facilities/[id]/loan-returns` |
| 短貸返却 新規作成 | `/facilities/[id]/loan-returns/new` |

---

## 変更範囲

### 既存ファイルの変更

- `src/components/orders/OrderButtons.tsx`  
  各ボタンの `onClick` モーダルトリガーを `<Link href="/facilities/[id]/case-orders">` 等に変更。  
  `長貸し処理` は引き続き `disabled` のまま。  
  モーダル関連の state・import は削除。

### 新規ファイル（8ファイル）

```
src/app/facilities/[id]/
  case-orders/page.tsx
  case-orders/new/page.tsx
  consumable-orders/page.tsx
  consumable-orders/new/page.tsx
  loan-orders/page.tsx
  loan-orders/new/page.tsx
  loan-returns/page.tsx
  loan-returns/new/page.tsx
```

### 既存ファイルの取り扱い

`src/components/orders/CaseOrderModal.tsx` 等のモーダルコンポーネントは**削除しない**。
（今後の再利用可能性を残す）

---

## 一覧ページの仕様

### 共通レイアウト

- パンくず: `← 施設に戻る`（施設詳細ページへのリンク）
- ページタイトル: 種別名（例: 症例発注）
- 「新規作成」ボタン: 右上に配置、`/new` ページへリンク
- データ取得: 既存 API `GET /api/{type}?facility_id=xxx` を使用（limit=50, offset=0）
- ローディング・エラー状態を表示

### 一覧テーブルのカラム

| 種別 | カラム |
|---|---|
| 症例発注 | 症例日時・手技名・ステータス・作成日 |
| 消耗品発注 | ステータス・作成日 |
| 短貸発注 | 手技名・メーカー・ステータス・作成日 |
| 短貸返却 | 返却日時・ステータス・作成日 |

ステータスは `draft` → `下書き`、`submitted` → `提出済`、`returned` → `返却済` と日本語表示。

---

## 新規作成ページの仕様

- 既存 Modal コンポーネントのフォーム部分をそのまま移植（スタイル・バリデーション含む）
- モーダルのラッパー（`fixed inset-0` 等）は不要なため除去
- 送信成功後: `router.push('/facilities/[id]/case-orders')` で一覧にリダイレクト
- キャンセルボタン: 一覧ページへ戻る

---

## データフロー

```
一覧ページ
  └─ useEffect → fetch GET /api/case-orders?facility_id=xxx
  └─ 結果をテーブル表示

新規作成ページ
  └─ フォーム送信 → fetch POST /api/case-orders
  └─ 成功 → router.push('/facilities/[id]/case-orders')
```

API・DB・RLS は変更なし（既存実装をそのまま使用）。

---

## スタイル方針

- 既存ページ（`/facilities/[id]/page.tsx` 等）と同じデザイントークンを使用
- フォントファミリー: `var(--font-oswald)` / `var(--font-ubuntu-mono)`
- カラー: `#072C2C`（メイン）、`#FF5F03`（アクセント）、`#6B7280`（グレー）

---

## テスト方針

- 新規ページのユニットテストはスコープ外（既存 API テストで担保済み）
- 手動確認: 一覧表示・新規作成・送信後リダイレクトの動作確認
